'use strict'

// One arm: loads the packages at PG_BENCH_MODULE and stays up, so compare.js can alternate the
// two arms scenario by scenario. Each message names a scenario and a duration, the reply is the
// queries per second it reached. The arms never share a heap or a JIT.

process.on('disconnect', () => process.exit(1))

const path = require('path')
const assert = require('assert/strict')
const { createQueueScenarios } = require('./queue-check')
const { createAutocommitWorkload } = require('./autocommit')
const { createTlsWorkload } = require('./tls')
const { createRowWorkload } = require('./rows')
const { createExecutorWorkload } = require('./executor')
const { createRequire } = require('module')
const fs = require('fs')

const root = path.resolve(process.env.PG_BENCH_MODULE)
const driverRequire = createRequire(path.join(root, 'packages/pg/package.json'))
for (const name of ['pg-protocol', 'pg-pool']) {
  assert.equal(
    fs.realpathSync(driverRequire.resolve(name)),
    fs.realpathSync(require.resolve(path.join(root, 'packages', name))),
    `${name} must resolve inside the measured checkout`
  )
}
const pg = require(path.join(root, 'packages/pg'))

const BATCH = 10
const ROWS = 500
const NAMED_CACHE = 1000
// the scratch table holds one range of ids per arm, so the arms' deletes never meet
const ARMS = 4
const SCRATCH_PER_ARM = 200000
const scratchFrom = Number(process.env.PG_BENCH_ARM || 0) * SCRATCH_PER_ARM + 1

// one column per family of pg-types parser, so a row parse pays for every conversion
const COLUMNS = `id int, small smallint, big bigint, real_value real, double_value double precision,
  numeric_value numeric(12, 4), string_value text, varchar_value varchar(20), null_value text,
  bool_value boolean, ts timestamptz, day date, json_value json, jsonb_value jsonb, uuid_value uuid,
  int_array int[], text_array text[], bytea_value bytea`
const COUNT = 18
// the columns with nothing to convert beyond the row itself, for the protocol-only scenarios
const SIMPLE = 'id, small, string_value, null_value, bool_value'
const ROW = `i, i, i * 100000, i / 3.0, i / 7.0, i / 11.0, 'wat', 'varchar', NULL, i % 2 = 0,
  now(), current_date, '{"a": 1}', '{"b": [1, 2]}', gen_random_uuid(), ARRAY[i, i + 1], ARRAY['x', 'y'], '\\xdeadbeef'`

// reads every field of every row, so the result is really consumed, and checks the shape
const consume = (rows, count = COUNT) => {
  for (const row of rows) {
    let seen = 0
    for (const key in row) if (row[key] !== undefined) seen++
    if (seen !== count) throw new Error(`expected ${count} fields, got ${seen}`)
  }
  return 1
}

const select = (limit, columns = '*') => ({
  text: `SELECT ${columns} FROM benchmark_rows ORDER BY id LIMIT ${limit}`,
  name: `benchmark_${limit}_${columns === '*' ? 'all' : 'simple'}`,
})

// what the parameterized writes send: one value per family of parameter encoding
const values = () => [
  1,
  2,
  '3000000000',
  1.5,
  2.25,
  '12.3456',
  'wat',
  'varchar',
  null,
  true,
  new Date(),
  '2024-01-02',
  { a: 1 },
  { b: [1, 2] },
  '00000000-0000-4000-8000-000000000000',
  [1, 2, 3],
  ['x', 'y'],
  Buffer.from('deadbeef', 'hex'),
]
const placeholders = values()
  .map((_, i) => `$${i + 1}`)
  .join(', ')

const parameterized = (value) => ({ text: 'SELECT $1::int AS value', values: [value] })
const batchConfigs = () => Array.from({ length: BATCH }, (_, i) => parameterized(i))
const namedConfigs = () => batchConfigs().map((config, i) => ({ ...config, name: `benchmark_batch_${i}` }))

const consumeValue = (result, value) => {
  assert.equal(result.rowCount, 1)
  assert.equal(result.rows.length, 1)
  assert.equal(result.rows[0].value, value)
  return 1
}

const consumeBatch = (results) => {
  assert.equal(results.length, BATCH)
  for (let i = 0; i < results.length; i++) consumeValue(results[i], i)
  return BATCH
}

const transactionBatch = async ({ client, configs }) => {
  await client.query('BEGIN')
  // Upstream has no batch API; run the same queries through its pipeline instead.
  const results =
    typeof client.batch === 'function'
      ? await client.batch(configs)
      : await Promise.all(configs.map((config) => client.query(config)))
  const count = consumeBatch(results)
  await client.query('COMMIT')
  return count + 2
}

// each scenario runs one iteration and returns how many queries it ran
const scenarios = ({ client, pipelined, prepared, batched, automatic, pool, contendedPool }) => {
  let deleted = 0
  let updated = 0
  const deleteOne = async () => {
    assert.ok(deleted < SCRATCH_PER_ARM, 'delete range exhausted before reset')
    const result = await client.query('DELETE FROM benchmark_scratch WHERE id = $1', [scratchFrom + deleted++])
    assert.equal(result.rowCount, 1)
    return 1
  }
  deleteOne.limit = SCRATCH_PER_ARM
  deleteOne.prepare = async () => {
    await client.query('DELETE FROM benchmark_scratch WHERE id >= $1 AND id < $2', [
      scratchFrom,
      scratchFrom + SCRATCH_PER_ARM,
    ])
    await client.query(
      "INSERT INTO benchmark_scratch (id, small, string_value) SELECT i, i % 1000, 'x' FROM generate_series($1::int, $2::int) i",
      [scratchFrom, scratchFrom + SCRATCH_PER_ARM - 1]
    )
    deleted = 0
  }
  return {
    'select 1 row, all types, prepared': async () => consume((await client.query(select(1))).rows),
    'select 100 rows, all types, prepared': async () => consume((await client.query(select(100))).rows),
    'select 500 rows, all types, prepared': async () => consume((await client.query(select(ROWS))).rows),
    'select 500 rows, simple types, prepared': async () => consume((await client.query(select(ROWS, SIMPLE))).rows, 5),
    'select 500 rows, simple types, array mode': async () =>
      consume((await client.query({ ...select(ROWS, SIMPLE), rowMode: 'array' })).rows, 5),
    'select 500 rows, simple types, binary': async () =>
      consume((await client.query({ ...select(ROWS, SIMPLE), binary: true })).rows, 5),
    // unnamed, so parse and bind are paid on every query
    'select by id, parameterized': async () =>
      consume((await client.query('SELECT * FROM benchmark_rows WHERE id = $1', [42])).rows),
    'select parameter, config object': async () => consumeValue(await client.query(parameterized(42)), 42),
    'select parameter, maxAutoPrepare': async () => consumeValue(await prepared.query(parameterized(42)), 42),
    [`transaction, explicit batch x${BATCH}`]: async () =>
      transactionBatch({ client: batched, configs: batchConfigs() }),
    [`transaction, named cached batch x${BATCH}`]: async () =>
      transactionBatch({ client: batched, configs: namedConfigs() }),
    [`transaction, autoBatch x${BATCH}`]: async () => {
      await automatic.query('BEGIN')
      const count = consumeBatch(await Promise.all(batchConfigs().map((config) => automatic.query(config))))
      await automatic.query('COMMIT')
      return count + 2
    },
    [`pool contention, max 1, select parameter x${BATCH}`]: async () => {
      const held = await contendedPool.connect()
      let pending
      try {
        pending = batchConfigs().map((config) => contendedPool.query(config))
        assert.equal(contendedPool.waitingCount, BATCH)
      } finally {
        held.release()
      }
      return consumeBatch(await Promise.all(pending))
    },
    'insert, all types, returning': async () =>
      consume(
        (await client.query(`INSERT INTO benchmark_scratch VALUES (${placeholders}) RETURNING *`, values())).rows
      ),
    'update, parameterized': async () => {
      const id = scratchFrom + SCRATCH_PER_ARM - 1 - (updated++ % 1000)
      await client.query('UPDATE benchmark_scratch SET small = $1, string_value = $2, ts = $3 WHERE id = $4', [
        7,
        'updated',
        new Date(),
        id,
      ])
      return 1
    },
    'delete, parameterized': deleteOne,
    // begin and commit go through the simple query protocol, the insert through the extended one
    'transaction, 3 queries': async () => {
      await client.query('BEGIN')
      await client.query(`INSERT INTO benchmark_scratch (id, small, string_value) VALUES ($1, $2, $3)`, [0, 1, 'tx'])
      await client.query('COMMIT')
      return 3
    },
    'pool query, select 1 row': async () => consume((await pool.query(select(1))).rows),
    [`select 100 rows, all types, pipelined x${BATCH}`]: async () => {
      const batch = await Promise.all(Array.from({ length: BATCH }, () => pipelined.query(select(100))))
      for (const res of batch) consume(res.rows)
      return BATCH
    },
  }
}

const measure = async (fn, ms) => {
  let count = 0
  let elapsed = 0
  do {
    // Destructive fixtures reset outside every timed window, including between bounded chunks.
    if (fn.prepare) await fn.prepare()
    global.gc()
    let iterations = 0
    const start = process.hrtime.bigint()
    let window
    do {
      count += await fn()
      iterations++
      window = Number(process.hrtime.bigint() - start) / 1e6
    } while (elapsed + window < ms && iterations < (fn.limit || Infinity))
    elapsed += window
  } while (elapsed < ms)
  if (fn.prepare) await fn.prepare()
  return (count * 1000) / elapsed
}

const ablation = async () => {
  const controls = Number(process.env.PG_BENCH_ARM) % 2 === 0
  const variants = {
    'autoBatch only': { autoBatch: true },
    'prepare only': { maxAutoPrepare: 16 },
    'autoBatch + prepare': { autoBatch: true, maxAutoPrepare: 16 },
  }
  const clients = []
  const all = {}
  for (const [name, options] of Object.entries(variants)) {
    const client = new pg.Client({ pipeline: true, ...(controls ? {} : options) })
    clients.push(client)
    await client.connect()
    all[`ablation, ${name}`] = async () => {
      assert.equal((await client.query('BEGIN')).command, 'BEGIN')
      const count = consumeBatch(await Promise.all(batchConfigs().map((config) => client.query(config))))
      assert.equal((await client.query('COMMIT')).command, 'COMMIT')
      return count + 2
    }
  }
  return { all, clients, pools: [] }
}

const payload = async () => {
  const client = new pg.Client()
  assert.equal(typeof client.batch, 'function', 'payload profile requires client.batch on both checkouts')
  const all = {}
  for (const { mib, bytes } of [
    { mib: 1, bytes: 1048576 },
    { mib: 8, bytes: 8388608 },
  ]) {
    const configs = Array.from({ length: 2 }, () => ({
      text: 'SELECT octet_length($1::bytea) AS n',
      values: [Buffer.alloc(bytes, 0x61)],
    }))
    all[`payload, explicit batch 2 x ${mib} MiB`] = async () => {
      assert.equal((await client.query('BEGIN')).command, 'BEGIN')
      const results = await client.batch(configs)
      assert.equal(results.length, 2)
      for (const result of results) {
        assert.equal(result.rowCount, 1)
        assert.equal(result.rows.length, 1)
        assert.equal(result.rows[0].n, bytes)
      }
      assert.equal((await client.query('COMMIT')).command, 'COMMIT')
      return 4
    }
  }
  await client.connect()
  return { all, clients: [client], pools: [] }
}

const setup = async (client) => {
  await client.query('DROP TABLE IF EXISTS benchmark_rows, benchmark_scratch')
  await client.query(`CREATE TABLE benchmark_rows (${COLUMNS}, PRIMARY KEY (id))`)
  await client.query(`INSERT INTO benchmark_rows SELECT ${ROW} FROM generate_series(1, ${ROWS}) i`)
  await client.query('CREATE UNLOGGED TABLE benchmark_scratch (LIKE benchmark_rows)')
  await client.query('CREATE INDEX ON benchmark_scratch (id)')
  await client.query(
    `INSERT INTO benchmark_scratch (id, small, string_value) SELECT i, i % 1000, 'x' FROM generate_series(1, ${
      ARMS * SCRATCH_PER_ARM
    }) i`
  )
}

const regression = async () => {
  const client = new pg.Client()
  const pipelined = new pg.Client({ pipeline: true })
  const prepared = new pg.Client({ maxAutoPrepare: 16 })
  const batched = new pg.Client({ pipeline: true, maxAutoPrepare: 16 })
  const automatic = new pg.Client({ pipeline: true, maxAutoPrepare: 16, autoBatch: true })
  const pool = new pg.Pool({ max: 2 })
  const contendedPool = new pg.Pool({ max: 1 })
  const clients = [client, pipelined, prepared, batched, automatic]
  const pools = [pool, contendedPool]
  await Promise.all(clients.map((connection) => connection.connect()))
  // Prewarm names before timing; these SELECTs need no benchmark tables.
  for (let i = 0; i < NAMED_CACHE; i++) {
    consumeValue(await batched.query({ ...parameterized(i), name: `benchmark_batch_${i}` }), i)
  }
  const all = scenarios({ client, pipelined, prepared, batched, automatic, pool, contendedPool })

  return { all, clients, pools }
}

const main = async () => {
  const profile = process.env.PG_BENCH_PROFILE || 'regression'
  let workload
  if (
    ['postgresjs', 'postgresjs-unprepared', 'postgresjs-unprepared-infer', 'postgresjs-unprepared-typed'].includes(
      profile
    )
  ) {
    workload = await require('./postgresjs').createPostgresJsWorkload({
      profile,
      pg,
      root,
      arm: Number(process.env.PG_BENCH_ARM),
    })
  } else if (profile === 'queue') {
    const Pool = require(path.join(root, 'packages/pg-pool'))
    const { scenarios: all, pools } = createQueueScenarios(Pool)
    workload = { all, pools, clients: [] }
  } else if (['autocommit', 'autocommit-prepare', 'autocommit-pipeline'].includes(profile)) {
    workload = await createAutocommitWorkload({ pg, profile, arm: Number(process.env.PG_BENCH_ARM) })
  } else if (['tls-handshake', 'tls-steady'].includes(profile)) {
    workload = await createTlsWorkload({ pg, profile, arm: Number(process.env.PG_BENCH_ARM) })
  } else if (['rows', 'row-formats'].includes(profile)) {
    workload = await createRowWorkload({ pg, profile, arm: Number(process.env.PG_BENCH_ARM) })
  } else if (profile === 'executor') {
    workload = await createExecutorWorkload({ pg, arm: Number(process.env.PG_BENCH_ARM) })
  } else if (['executor-row-mode', 'executor-int-parser'].includes(profile)) {
    workload = await createExecutorWorkload({ pg, profile, arm: Number(process.env.PG_BENCH_ARM) })
  } else if (profile === 'executor-regression') {
    workload = await createExecutorWorkload({ pg, arm: 1 })
  } else if (profile === 'payload') {
    workload = await payload()
  } else {
    workload = await (profile === 'ablation' ? ablation() : regression())
  }
  const { all, clients, pools } = workload
  process.on('message', async (msg) => {
    try {
      if (msg.type === 'setup') {
        if (workload.setup) await workload.setup()
        else if (profile === 'regression') await setup(clients[0])
        process.send({ ok: true })
      } else if (msg.type === 'prepare') {
        if (workload.prepare) await workload.prepare()
        process.send({ ok: true })
      } else if (msg.type === 'run') {
        process.send({ ok: true, qps: await measure(all[msg.scenario], msg.ms) })
      } else if (msg.type === 'end') {
        await Promise.all([...clients, ...pools].map((connection) => connection.end()))
        process.send({ ok: true }, () => process.exit(0))
      }
    } catch (err) {
      process.send({ ok: false, error: String(err.stack || err) })
    }
  })
  process.send({ ok: true, scenarios: Object.keys(all), metadata: workload.metadata || null })
}

main().catch((err) => {
  process.stderr.write(`${err.stack || err}\n`)
  process.exit(1)
})
