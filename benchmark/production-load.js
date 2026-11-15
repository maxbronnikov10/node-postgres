'use strict'

const assert = require('assert/strict')
const fs = require('fs')
const path = require('path')
const { pathToFileURL } = require('url')
const { createHistogram, monitorEventLoopDelay, performance } = require('perf_hooks')
const { createTlsConfig } = require('./tls')
const { DelayedProxy } = require('./delayed-proxy')
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))

class ProductionLoad {
  constructor({ target, rate, seconds, cap = 1024 }) {
    Object.assign(this, { target, rate, seconds, cap })
    this.count = rate * seconds
    this.generated = this.completed = this.failed = this.schedulerRejected = this.outstanding = 0
    this.writes = this.transactions = this.peakOutstanding = this.peakWaiting = this.peakInFlight = 0
    this.success = createHistogram()
    this.failure = createHistogram()
    this.schedulerLatency = createHistogram()
    this.errors = {}
    this.samples = []
  }

  static operation(index) {
    const part = index % 100
    return {
      kind: part < 70 ? 'point' : part < 90 ? 'range' : part < 98 ? 'write' : 'transaction',
      id: 3 + ((index * 37) % 99978),
    }
  }

  static histogram(histogram) {
    return {
      count: histogram.count,
      p50Millis: histogram.count ? histogram.percentile(50) / 1000 : 0,
      p95Millis: histogram.count ? histogram.percentile(95) / 1000 : 0,
      p99Millis: histogram.count ? histogram.percentile(99) / 1000 : 0,
      maxMillis: histogram.count ? histogram.max / 1000 : 0,
    }
  }

  sample() {
    const memory = process.memoryUsage()
    this.memoryPeak.rss = Math.max(this.memoryPeak.rss, memory.rss)
    this.memoryPeak.heapUsed = Math.max(this.memoryPeak.heapUsed, memory.heapUsed)
    const diagnostics = this.target.diagnostics?.()
    if (diagnostics) {
      this.peakWaiting = Math.max(this.peakWaiting, diagnostics.waiting)
      this.peakInFlight = Math.max(this.peakInFlight, diagnostics.inFlight)
      assert.ok(diagnostics.waiting <= 256)
      assert.ok(diagnostics.inFlight <= 64)
    }
    if (performance.now() - this.lastSample >= 10000) {
      this.lastSample = performance.now()
      this.samples.push({
        elapsedMillis: this.lastSample - this.started,
        completed: this.completed,
        failed: this.failed,
        schedulerRejected: this.schedulerRejected,
        outstanding: this.outstanding,
        memory,
        cpu: process.cpuUsage(this.cpuStart),
        diagnostics,
      })
    }
  }

  dispatch(index) {
    const intended = this.started + (index * 1000) / this.rate
    if (this.outstanding >= this.cap) {
      this.schedulerRejected++
      this.schedulerLatency.record(Math.max(1, Math.round((performance.now() - intended) * 1000)))
      return
    }
    const operation = ProductionLoad.operation(index)
    this.outstanding++
    this.peakOutstanding = Math.max(this.peakOutstanding, this.outstanding)
    Promise.resolve()
      .then(() => this.target.run(operation))
      .then(
        () => {
          this.completed++
          if (operation.kind === 'write') this.writes++
          if (operation.kind === 'transaction') this.transactions++
          this.success.record(Math.max(1, Math.round((performance.now() - intended) * 1000)))
        },
        (error) => {
          this.failed++
          this.failure.record(Math.max(1, Math.round((performance.now() - intended) * 1000)))
          const key = `${error.code || error.name}/${error.outcome || 'unknown'}`
          this.errors[key] = (this.errors[key] || 0) + 1
        }
      )
      .finally(() => {
        this.outstanding--
        if (this.generated === this.count && !this.outstanding) this.resolveDrain()
      })
  }

  generate() {
    const due = Math.min(this.count, Math.floor(((performance.now() - this.started) * this.rate) / 1000) + 1)
    while (this.generated < due) this.dispatch(this.generated++)
    if (this.generated < this.count) {
      this.timer = setTimeout(
        () => this.generate(),
        Math.max(1, this.started + (this.generated * 1000) / this.rate - performance.now())
      )
    } else {
      this.generationMillis = performance.now() - this.started
      this.completedAtWindowEnd = this.completed
      if (!this.outstanding) this.resolveDrain()
    }
  }

  async run() {
    this.memoryStart = process.memoryUsage()
    this.memoryPeak = { rss: this.memoryStart.rss, heapUsed: this.memoryStart.heapUsed }
    this.cpuStart = process.cpuUsage()
    this.started = this.lastSample = performance.now()
    const loop = monitorEventLoopDelay({ resolution: 10 })
    loop.enable()
    let deadline
    const sampler = setInterval(() => this.sample(), 100)
    try {
      await Promise.race([
        new Promise((resolve) => {
          this.resolveDrain = resolve
          this.generate()
        }),
        new Promise((_, reject) => {
          deadline = setTimeout(() => reject(new Error('load drain exceeded 30 seconds')), this.seconds * 1000 + 30000)
        }),
      ])
      this.sample()
      assert.equal(this.completed + this.failed + this.schedulerRejected, this.count)
      const drainedAt = performance.now()
      const memoryEnd = process.memoryUsage()
      global.gc?.()
      return {
        offered: this.count,
        offeredPerSecond: this.rate,
        offeredSeconds: this.seconds,
        generationMillis: this.generationMillis,
        drainMillis: drainedAt - this.started - this.generationMillis,
        completedAtWindowEnd: this.completedAtWindowEnd,
        completed: this.completed,
        failed: this.failed,
        schedulerRejections: {
          count: this.schedulerRejected,
          outcome: 'not-sent',
          safeToRetry: true,
          latency: ProductionLoad.histogram(this.schedulerLatency),
        },
        errors: this.errors,
        acknowledgedWrites: this.writes,
        acknowledgedTransactions: this.transactions,
        successLatency: ProductionLoad.histogram(this.success),
        failureLatency: ProductionLoad.histogram(this.failure),
        peakOutstanding: this.peakOutstanding,
        diagnosticsAvailable: Boolean(this.target.diagnostics),
        peakWaiting: this.target.diagnostics ? this.peakWaiting : null,
        peakInFlight: this.target.diagnostics ? this.peakInFlight : null,
        cpu: process.cpuUsage(this.cpuStart),
        memory: {
          start: this.memoryStart,
          peak: this.memoryPeak,
          end: memoryEnd,
          afterGC: global.gc ? process.memoryUsage() : null,
        },
        eventLoopP99Millis: loop.percentile(99) / 1e6,
        samples: this.samples,
      }
    } finally {
      clearTimeout(this.timer)
      clearTimeout(deadline)
      clearInterval(sampler)
      loop.disable()
    }
  }
}

class DatabaseTarget {
  constructor({ driver, resource, schema }) {
    Object.assign(this, { driver, resource })
    assert.match(schema, /^nodepg_load_[0-9]+$/)
    this.table = `${schema}.production_rows`
    this.identifier = driver === 'query' ? null : resource.identifier(schema, 'production_rows')
    if (driver === 'query')
      this.diagnostics = () => ({ waiting: resource.waitingCount, inFlight: resource.inFlightCount })
  }

  validateReads({ rows, id, count }) {
    assert.equal(rows.length, count)
    for (let index = 0; index < rows.length; index++) {
      const row = rows[index]
      assert.equal(row.id, id + index)
      assert.equal(row.value, 7)
      assert.ok(Number.isSafeInteger(row.counter) && row.counter >= 0)
      assert.equal(row.label, `row-${row.id}`)
      assert.deepEqual(row.payload, { id: row.id, payload: 'x'.repeat(128) })
      assert.deepEqual(Object.keys(row).sort(), ['counter', 'id', 'label', 'payload', 'value'])
    }
  }

  validateWrite({ rows, id }) {
    assert.equal(rows.length, 1)
    assert.equal(rows[0].id, id)
    assert.ok(Number.isSafeInteger(rows[0].counter) && rows[0].counter > 0)
    assert.deepEqual(Object.keys(rows[0]).sort(), ['counter', 'id'])
  }

  async tagged({ sql, kind, id }) {
    const key = this.driver === 'postgresjs-typed' ? sql.typed(id, 23) : id
    if (kind === 'point')
      return sql`SELECT id, value, counter, label, payload FROM ${this.identifier} WHERE id = ${key}`
    if (kind === 'range') {
      const upper = this.driver === 'postgresjs-typed' ? sql.typed(id + 20, 23) : id + 20
      return sql`SELECT id, value, counter, label, payload FROM ${this.identifier} WHERE id >= ${key} AND id < ${upper} ORDER BY id`
    }
    return sql`UPDATE ${this.identifier} SET counter = counter + 1 WHERE id = ${key} RETURNING id, counter`
  }

  async run({ kind, id }) {
    if (kind === 'transaction') {
      if (this.driver === 'query') {
        const lease = await this.resource.reserve()
        try {
          await lease.query({ text: 'BEGIN' })
          for (const key of [1, 2])
            this.validateWrite({
              rows: (
                await lease.query({
                  text: `UPDATE ${this.table} SET counter = counter + 1 WHERE id = $1 RETURNING id, counter`,
                  values: [key],
                })
              ).rows,
              id: key,
            })
          const commit = await lease.query({ text: 'COMMIT' })
          assert.equal(commit.command, 'COMMIT')
        } catch (error) {
          await lease.query({ text: 'ROLLBACK' }).catch(() => {})
          throw error
        } finally {
          lease.release()
        }
      } else {
        await this.resource.begin(async (sql) => {
          for (const key of [1, 2])
            this.validateWrite({ rows: await this.tagged({ sql, kind: 'write', id: key }), id: key })
        })
      }
      return
    }
    let rows
    if (this.driver === 'query') {
      rows = await this.resource.rows(
        kind === 'point'
          ? `SELECT id, value, counter, label, payload FROM ${this.table} WHERE id = $1`
          : kind === 'range'
          ? `SELECT id, value, counter, label, payload FROM ${this.table} WHERE id >= $1 AND id < $2 ORDER BY id`
          : `UPDATE ${this.table} SET counter = counter + 1 WHERE id = $1 RETURNING id, counter`,
        kind === 'range' ? [id, id + 20] : [id]
      )
    } else rows = await this.tagged({ sql: this.resource, kind, id })
    if (kind === 'write') this.validateWrite({ rows, id })
    else this.validateReads({ rows, id, count: kind === 'point' ? 1 : 20 })
  }

  sleep(seconds) {
    return this.driver === 'query'
      ? this.resource.query('SELECT pg_sleep($1)', [seconds])
      : this.resource`SELECT pg_sleep(${seconds})`
  }
}

class ProductionBenchmark {
  constructor(options) {
    this.options = options
  }

  async metadata() {
    const { rows } = await this.admin.query(
      `SELECT a.pid, a.application_name, s.ssl, s.version AS tls_version, s.cipher
      FROM pg_stat_activity a LEFT JOIN pg_stat_ssl s USING (pid) WHERE a.application_name = $1 ORDER BY a.pid`,
      [this.applicationName]
    )
    const server = (
      await this.admin.query(`SELECT version() AS version, current_database() AS database,
      current_setting('fsync') AS fsync, current_setting('full_page_writes') AS full_page_writes,
      current_setting('synchronous_commit') AS synchronous_commit, current_setting('server_version_num') AS server_version_num`)
    ).rows[0]
    for (const name of ['fsync', 'full_page_writes', 'synchronous_commit']) assert.equal(server[name], 'on')
    if (process.env.PG_BENCH_TLS_CA)
      for (const row of rows) {
        assert.equal(row.ssl, true)
        assert.equal(row.tls_version, 'TLSv1.3')
      }
    return {
      server,
      connections: rows,
      connectionObservation: 'server backends; not proof of frontend pool size behind a pooler',
    }
  }

  async overload() {
    let peakWaiting = 0
    let peakInFlight = 0
    const sample = () => {
      const diagnostics = this.target.diagnostics?.()
      if (diagnostics) {
        peakWaiting = Math.max(peakWaiting, diagnostics.waiting)
        peakInFlight = Math.max(peakInFlight, diagnostics.inFlight)
        assert.ok(diagnostics.waiting <= 256 && diagnostics.inFlight <= 64)
      }
    }
    const sampler = setInterval(sample, 1)
    let results
    try {
      const batch = Array.from({ length: 512 }, () => Promise.resolve(this.target.sleep(0.02)))
      sample()
      results = await Promise.allSettled(batch)
    } finally {
      clearInterval(sampler)
    }
    const rejected = results.filter((result) => result.status === 'rejected')
    assert.ok(rejected.length > 0)
    for (const result of rejected) {
      assert.equal(result.reason.code, 'PG_EXECUTOR_OVERLOADED')
      assert.equal(result.reason.outcome, 'not-sent')
      assert.equal(result.reason.safeToRetry, true)
    }
    await this.target.sleep(0)
    return {
      offered: 512,
      rejected: rejected.length,
      outcome: 'not-sent',
      safeToRetry: true,
      recovered: true,
      peakWaiting: this.target.diagnostics ? peakWaiting : null,
      peakInFlight: this.target.diagnostics ? peakInFlight : null,
    }
  }

  async recovery() {
    const name = `${this.applicationName}_recovery`
    const executor = new this.pg.QueryExecutor({
      ...this.connectionOptions,
      application_name: name,
      max: 1,
      maxInFlightPerConnection: 1,
    })
    try {
      const pid = (await executor.rows('SELECT pg_backend_pid() AS pid'))[0].pid
      const failed = executor.query('SELECT pg_sleep(10)').then(
        () => null,
        (error) => error
      )
      let active = false
      for (let attempt = 0; attempt < 100; attempt++) {
        const rows = (
          await this.admin.query(
            'SELECT pid FROM pg_stat_activity WHERE pid = $1 AND application_name = $2 AND state = $3 AND query = $4',
            [pid, name, 'active', 'SELECT pg_sleep(10)']
          )
        ).rows
        if (rows.length) {
          active = true
          break
        }
        await delay(10)
      }
      assert.ok(active, 'dedicated read must be active before termination')
      const terminated = await this.admin.query(
        'SELECT pg_terminate_backend(pid) AS killed FROM pg_stat_activity WHERE pid = $1 AND application_name = $2',
        [pid, name]
      )
      assert.equal(terminated.rows[0]?.killed, true)
      const error = await failed
      assert.ok(error)
      assert.equal(error.outcome, 'unknown')
      assert.equal(error.safeToRetry, false)
      await delay(Math.min(5000, Math.max(1000, error.retryAfterMillis || 0)))
      assert.equal((await executor.rows('SELECT 42 AS value'))[0].value, 42)
      return {
        terminatedOwnPid: pid,
        rejectedOutcome: error.outcome,
        safeToRetry: error.safeToRetry,
        recoveredNewRead: true,
        replayed: false,
      }
    } finally {
      await executor.destroy()
      await executor.end()
    }
  }

  async run() {
    const { driver, root, rate, seconds } = this.options
    this.pg = require(path.join(root, 'packages/pg'))
    const tls = process.env.PG_BENCH_TLS_CA
      ? createTlsConfig().options({ context: 'shared', negotiation: 'postgres' })
      : {}
    this.admin = new this.pg.Client({
      ...tls,
      ...(process.env.PG_BENCH_ADMIN_PORT ? { port: Number(process.env.PG_BENCH_ADMIN_PORT) } : {}),
      ...(process.env.PG_BENCH_ADMIN_DATABASE ? { database: process.env.PG_BENCH_ADMIN_DATABASE } : {}),
      application_name: `nodepg_load_admin_${process.pid}`,
    })
    await this.admin.connect()
    let created = false
    try {
      const database = (await this.admin.query('SELECT current_database() AS name')).rows[0].name
      assert.match(database, /^(nodepg_|benchmark)/, 'requires an explicitly disposable database')
      const schema = `nodepg_load_${process.pid}`
      assert.match(schema, /^nodepg_load_[0-9]+$/)
      await this.admin.query(`CREATE SCHEMA ${schema}`)
      created = true
      this.schema = schema
      await this.admin.query(
        `CREATE TABLE ${schema}.production_rows (id integer PRIMARY KEY, value integer NOT NULL, counter integer NOT NULL, label text NOT NULL, payload jsonb NOT NULL)`
      )
      await this.admin.query(
        `INSERT INTO ${schema}.production_rows SELECT id, $1::int, $2::int, $3::text || id, jsonb_build_object('id', id, 'payload', $4::text) FROM generate_series(1, $5::int) AS id`,
        [7, 0, 'row-', 'x'.repeat(128), 100000]
      )
      await this.admin.query(`ANALYZE ${schema}.production_rows`)
      await this.admin.query('CHECKPOINT')
      this.applicationName = `nodepg_load_${process.pid}_${driver}`
      const delayMillis = Number(process.env.PG_BENCH_DELAY_MS || 0)
      assert.ok(Number.isFinite(delayMillis) && delayMillis >= 0 && delayMillis <= 1000)
      const endpoint = {
        host: process.env.PGHOST || this.admin.connectionParameters.host,
        port: Number(process.env.PGPORT || 5432),
        database: process.env.PGDATABASE || this.admin.connectionParameters.database,
      }
      if (delayMillis) {
        this.proxy = await new DelayedProxy({ host: endpoint.host, port: endpoint.port, delayMillis }).start()
        Object.assign(endpoint, { host: '127.0.0.1', port: this.proxy.port })
      }
      const defaultPool = driver === 'tag' && process.env.PG_BENCH_POOL_DEFAULTS === '1'
      this.connectionOptions = {
        ...tls,
        ...endpoint,
        application_name: this.applicationName,
        ...(defaultPool ? {} : { max: 4, maxInFlightPerConnection: 16 }),
        maxPending: 256,
        query_timeout: 5000,
        maxAutoPrepare: process.env.PG_BENCH_PREPARE === '0' ? 0 : 256,
      }
      let version = this.pg.version || require(path.join(root, 'packages/pg/package.json')).version
      if (driver === 'query') this.resource = new this.pg.QueryExecutor(this.connectionOptions)
      else if (driver === 'tag') this.resource = this.pg.postgres(this.connectionOptions)
      else {
        const modulePath =
          process.env.PG_BENCH_POSTGRESJS_MODULE || '/tmp/nodepg-postgresjs-20261115/node_modules/postgres'
        version = require(path.join(modulePath, 'package.json')).version
        assert.equal(version, '4.1.1')
        const postgres = (await import(pathToFileURL(require.resolve(modulePath)).href)).default
        const config = this.admin.connectionParameters
        this.resource = postgres({
          host: endpoint.host || config.host,
          port: endpoint.port || config.port,
          username: config.user,
          password: config.password,
          database: endpoint.database,
          ssl: tls.ssl || false,
          max: 4,
          max_pipeline: 16,
          prepare: process.env.PG_BENCH_PREPARE !== '0',
          connection: {
            application_name: this.applicationName,
          },
        })
      }
      this.target = new DatabaseTarget({ driver, resource: this.resource, schema })
      await Promise.all(Array.from({ length: 80 }, () => Promise.resolve(this.target.sleep(0.01))))
      const initial = await this.metadata()
      if (process.env.PG_BENCH_POOLER !== '1')
        assert.equal(initial.connections.length, defaultPool ? 2 : 4, 'all expected connections must be warm')
      global.gc?.()
      const load = await new ProductionLoad({ target: this.target, rate, seconds }).run()
      const sum = Number(
        (await this.admin.query(`SELECT sum(counter) AS total FROM ${schema}.production_rows`)).rows[0].total
      )
      assert.equal(
        sum,
        load.acknowledgedWrites + 2 * load.acknowledgedTransactions,
        'durable counter equals acknowledged writes exactly'
      )
      assert.ok(!Object.keys(load.errors).some((key) => key.startsWith('ERR_ASSERTION')), 'returned rows must validate')
      const final = await this.metadata()
      const overload = driver.startsWith('postgresjs') ? null : await this.overload()
      const recovery = driver === 'query' && process.env.PG_BENCH_POOLER !== '1' ? await this.recovery() : null
      return {
        driver,
        driverVersion: version,
        nodeVersion: process.version,
        fixtureRows: 100000,
        description: 'isolated durable OLTP-like synthetic load; not evidence of production capacity',
        delayMillisPerDirection: delayMillis,
        settings: {
          max: defaultPool ? 2 : 4,
          depth: 16,
          maxPending: driver.startsWith('postgresjs') ? null : 256,
          applicationOutstandingCap: 1024,
          prepare: process.env.PG_BENCH_PREPARE !== '0',
          queryTimeoutMillis: driver.startsWith('postgresjs') ? null : 5000,
        },
        initial,
        final,
        load,
        counterVerification: { expected: load.acknowledgedWrites + 2 * load.acknowledgedTransactions, actual: sum },
        overload,
        recovery,
        recoverySkippedReason:
          process.env.PG_BENCH_POOLER === '1'
            ? 'backend ownership changes under transaction pooling'
            : driver !== 'query'
            ? 'dedicated QueryExecutor phase only'
            : null,
      }
    } finally {
      try {
        if (this.resource) {
          if (driver === 'query') await this.resource.destroy()
          let timeout
          try {
            await Promise.race([
              this.resource.end({ timeout: 1 }),
              new Promise((_, reject) => {
                timeout = setTimeout(() => reject(new Error('resource close exceeded 5 seconds')), 5000)
              }),
            ])
          } finally {
            clearTimeout(timeout)
          }
        }
      } finally {
        try {
          await this.proxy?.end()
          if (created) await this.admin.query(`DROP SCHEMA ${this.schema} CASCADE`)
        } finally {
          try {
            await this.admin.end()
          } finally {
            await this.proxy?.end()
          }
        }
      }
    }
  }

  static arguments(argv) {
    const options = { root: '.', driver: 'tag', seconds: 180, rate: 1000 }
    const allowed = new Set(['root', 'driver', 'seconds', 'rate', 'output'])
    for (let index = 0; index < argv.length; index += 2) {
      const key = argv[index].replace(/^--/, '')
      assert.ok(
        argv[index].startsWith('--') && allowed.has(key) && argv[index + 1],
        'expected --root/--driver/--seconds/--rate/--output value'
      )
      options[key] = argv[index + 1]
    }
    options.root = path.resolve(options.root)
    options.rate = Number(options.rate)
    options.seconds = Number(options.seconds)
    assert.ok(['tag', 'query', 'postgresjs', 'postgresjs-typed'].includes(options.driver))
    assert.ok(Number.isSafeInteger(options.rate) && options.rate >= 1 && options.rate <= 50000)
    assert.ok(Number.isSafeInteger(options.seconds) && options.seconds >= 1 && options.seconds <= 1800)
    assert.ok(Number.isSafeInteger(options.rate * options.seconds))
    return options
  }
}

if (require.main === module) {
  const main = async () => {
    const options = ProductionBenchmark.arguments(process.argv.slice(2))
    const result = await new ProductionBenchmark(options).run()
    const json = `${JSON.stringify(result, null, 2)}\n`
    if (options.output) fs.writeFileSync(options.output, json)
    process.stdout.write(json)
  }
  main().catch((error) => {
    process.stderr.write(`${error.stack || error}\n`)
    process.exit(1)
  })
}

module.exports = { ProductionLoad, ProductionBenchmark }
