'use strict'

const assert = require('assert/strict')
const { execFileSync } = require('child_process')
const fs = require('fs')
const { performance } = require('perf_hooks')
const { setTimeout: delay } = require('timers/promises')
const pg = require('../packages/pg')

class PhysicalStandbyExperiment {
  constructor() {
    this.container = process.env.PG_PHYSICAL_PRIMARY_CONTAINER
    assert.match(this.container || '', /^nodepg-physical-[a-zA-Z0-9][a-zA-Z0-9_.-]*$/)
    this.output = process.env.PG_PHYSICAL_OUTPUT
    assert.ok(this.output, 'PG_PHYSICAL_OUTPUT is required')
    this.primaryPort = Number(process.env.PG_PHYSICAL_PRIMARY_PORT)
    this.standbyPort = Number(process.env.PG_PHYSICAL_STANDBY_PORT)
    for (const port of [this.primaryPort, this.standbyPort]) {
      assert.ok(Number.isInteger(port) && port > 0 && port <= 65535, 'explicit valid fixture ports required')
    }
    assert.notEqual(this.primaryPort, this.standbyPort)
    this.options = {
      host: '127.0.0.1',
      user: 'postgres',
      database: 'nodepg_physical',
      ssl: false,
      connectionTimeoutMillis: 1000,
      query_timeout: 15000,
    }
    this.primary = new pg.Client({ ...this.options, port: this.primaryPort })
    this.standby = new pg.Client({ ...this.options, port: this.standbyPort })
    // Killing the fixture also closes this otherwise idle admin connection.
    this.primary.on('error', () => {})
    this.standby.on('error', () => {})
    this.table = pg.escapeIdentifier(`physical_markers_${process.pid}_${Date.now()}`)
    this.queryTag = `nodepg_physical_inflight_${process.pid}_${Date.now()}`
    this.executor = new pg.QueryExecutor({
      ...this.options,
      endpoints: [
        { host: '127.0.0.1', port: this.primaryPort },
        { host: '127.0.0.1', port: this.standbyPort },
      ],
      targetSessionAttrs: 'read-write',
      max: 1,
      maxInFlightPerConnection: 2,
      maxPending: 16,
    })
  }

  async waitFor({ description, check }) {
    const deadline = performance.now() + 15000
    do {
      const result = await check()
      if (result) return result
      await delay(100)
    } while (performance.now() < deadline)
    throw new Error(`Timed out waiting for ${description}`)
  }

  async run() {
    try {
      await this.primary.connect()
      await this.standby.connect()
      const primaryRole = (await this.primary.query('SELECT pg_is_in_recovery() AS recovery, version() AS version'))
        .rows[0]
      const standbyRole = (await this.standby.query('SELECT pg_is_in_recovery() AS recovery, version() AS version'))
        .rows[0]
      assert.equal(primaryRole.recovery, false)
      assert.equal(standbyRole.recovery, true)
      await this.primary.query(`CREATE TABLE ${this.table} (marker text NOT NULL)`)
      const before = await this.executor.query(`INSERT INTO ${this.table} VALUES ($1)`, ['before'])
      assert.equal(before.rowCount, 1)
      const { lsn } = (await this.primary.query('SELECT pg_current_wal_lsn()::text AS lsn')).rows[0]
      const replay = await this.waitFor({
        description: 'committed seed WAL replay',
        check: async () => {
          const row = (
            await this.standby.query(
              'SELECT pg_last_wal_replay_lsn()::text AS replay_lsn, pg_last_wal_replay_lsn() >= $1::pg_lsn AS caught_up',
              [lsn]
            )
          ).rows[0]
          return row.caught_up && row
        },
      })
      const pending = this.executor
        .query(`/* ${this.queryTag} */ INSERT INTO ${this.table} SELECT $1::text FROM pg_sleep(30)`, ['inflight'])
        .then(
          (result) => ({ result }),
          (error) => ({ error })
        )
      await this.waitFor({
        description: 'inflight INSERT sleeping on primary',
        check: async () => {
          const result = await this.primary.query(
            "SELECT pid FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND datname = 'nodepg_physical' AND state = 'active' AND wait_event = 'PgSleep' AND position($1 in query) > 0",
            [this.queryTag]
          )
          return result.rowCount === 1
        },
      })
      const killedAt = performance.now()
      execFileSync('sudo', ['-n', 'docker', 'kill', '--signal=KILL', this.container], { timeout: 10000, stdio: 'pipe' })
      const { error } = await pending
      assert.ok(error, 'assigned INSERT must reject after primary kill')
      assert.equal(error.outcome, 'unknown')
      assert.equal(error.safeToRetry, false)
      assert.equal((await this.standby.query('SELECT pg_promote(true, 10) AS promoted')).rows[0].promoted, true)
      assert.equal((await this.standby.query('SELECT pg_is_in_recovery() AS recovery')).rows[0].recovery, false)
      const after = await this.waitFor({
        description: 'new write through the same executor after promotion',
        check: async () => {
          try {
            return await this.executor.query(`INSERT INTO ${this.table} VALUES ($1)`, ['after'])
          } catch (failure) {
            // Only fresh submissions proven unsent may be attempted again.
            if (failure.outcome !== 'not-sent' || failure.safeToRetry !== true) throw failure
            return null
          }
        },
      })
      const recoveryMillis = performance.now() - killedAt
      assert.equal(after.rowCount, 1)
      const markers = (await this.standby.query(`SELECT marker FROM ${this.table} ORDER BY marker`)).rows
      assert.deepEqual(markers, [{ marker: 'after' }, { marker: 'before' }])
      const evidence = {
        postgresVersion: { primary: primaryRole.version, standby: standbyRole.version },
        roles: {
          initialPrimaryRecovery: primaryRole.recovery,
          initialStandbyRecovery: standbyRole.recovery,
          promotedRecovery: false,
        },
        replay: { requiredLsn: lsn, replayLsn: replay.replay_lsn, confirmed: replay.caught_up },
        inflight: { code: error.code, outcome: error.outcome, safeToRetry: error.safeToRetry },
        killToFirstNewSuccessMillis: recoveryMillis,
        markerRows: markers,
        markerCounts: { before: 1, after: 1, inflight: 0 },
        limits:
          'Manual promotion; committed seed WAL explicitly replayed before kill; sleeping INSERT uncommitted. No automatic election or zero-RPO claim.',
      }
      fs.writeFileSync(this.output, `${JSON.stringify(evidence)}\n`)
      process.stdout.write(`${JSON.stringify(evidence)}\n`)
    } finally {
      await this.executor.destroy()
      await Promise.allSettled([this.primary.end(), this.standby.end()])
    }
  }
}

new PhysicalStandbyExperiment().run().catch((error) => {
  process.stderr.write(`${error.stack}\n`)
  process.exitCode = 1
})
