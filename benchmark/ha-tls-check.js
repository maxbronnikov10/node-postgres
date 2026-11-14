'use strict'

const assert = require('assert/strict')
const fs = require('fs')
const pg = require('../packages/pg')

class HaTlsFixture {
  constructor() {
    assert.ok(process.env.PG_HA_TLS_CA, 'PG_HA_TLS_CA is required')
    this.host = process.env.PGHOST || '127.0.0.1'
    this.rwPort = Number(process.env.PGPORT)
    this.roPort = Number(process.env.PG_HA_RO_PORT)
    this.ssl = {
      ca: fs.readFileSync(process.env.PG_HA_TLS_CA),
      rejectUnauthorized: true,
      minVersion: 'TLSv1.3',
      maxVersion: 'TLSv1.3',
    }
    this.options = { ssl: this.ssl, sslnegotiation: 'direct', connectionTimeoutMillis: 1000 }
    this.control = new pg.Client(this.options)
    this.table = pg.escapeIdentifier(`ha_tls_${process.pid}`)
  }

  async run() {
    await this.control.connect()
    try {
      await this.control.query(`CREATE TABLE ${this.table} (marker text NOT NULL)`)
      await this.checkBadIdentity()
      await this.checkFallback()
      const result = await this.control.query(`SELECT marker FROM ${this.table}`)
      assert.deepEqual(result.rows, [{ marker: 'tls-fallback' }])
      process.stdout.write('TLS endpoint rejection, role selection, URI overrides and exactly-once INSERT passed\n')
    } finally {
      try {
        await this.control.query(`DROP TABLE IF EXISTS ${this.table}`)
      } finally {
        await this.control.end()
      }
    }
  }

  async checkBadIdentity() {
    const executor = new pg.QueryExecutor({
      ...this.options,
      endpoints: [{ host: this.host, port: this.rwPort, ssl: { ...this.ssl, servername: 'wrong.invalid' } }],
      targetSessionAttrs: 'read-write',
      max: 1,
    })
    try {
      await assert.rejects(executor.query(`INSERT INTO ${this.table} VALUES ($1)`, ['bad-identity']), (error) => {
        assert.equal(error.outcome, 'not-sent')
        assert.equal(error.safeToRetry, true)
        assert.equal(error.cause.code, 'ERR_TLS_CERT_ALTNAME_INVALID')
        return true
      })
    } finally {
      await executor.end()
    }
  }

  async checkFallback() {
    const executor = new pg.QueryExecutor({
      ...this.options,
      // Explicit endpoints must override the connection URI's deliberately wrong port.
      connectionString: `postgres://${encodeURIComponent(this.control.user)}@127.0.0.1:1/${encodeURIComponent(
        this.control.database
      )}`,
      endpoints: [
        { host: this.host, port: this.roPort, ssl: this.ssl },
        { host: this.host, port: this.rwPort, ssl: this.ssl },
      ],
      targetSessionAttrs: 'read-write',
      max: 1,
    })
    try {
      const result = await executor.query(`INSERT INTO ${this.table} VALUES ($1)`, ['tls-fallback'])
      assert.equal(result.rowCount, 1)
      for (const { client } of executor._records) {
        assert.equal(client.port, this.rwPort)
        assert.equal(client.connection.stream.authorized, true)
        assert.equal(client.connection.stream.getProtocol(), 'TLSv1.3')
        assert.equal(client.connection.stream.alpnProtocol, 'postgresql')
      }
    } finally {
      await executor.end()
    }
  }
}

new HaTlsFixture().run().catch((error) => {
  process.stderr.write(`${error.stack}\n`)
  process.exitCode = 1
})
