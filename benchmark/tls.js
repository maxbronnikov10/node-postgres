'use strict'

const assert = require('assert/strict')
const fs = require('fs')
const tls = require('tls')

class BenchmarkTlsConfig {
  constructor() {
    assert.ok(process.env.PG_BENCH_TLS_CA, 'PG_BENCH_TLS_CA is required for TLS benchmarks')
    this.ssl = {
      ca: fs.readFileSync(process.env.PG_BENCH_TLS_CA),
      rejectUnauthorized: true,
      minVersion: 'TLSv1.3',
      maxVersion: 'TLSv1.3',
      ...(process.env.PG_BENCH_TLS_SERVERNAME ? { servername: process.env.PG_BENCH_TLS_SERVERNAME } : {}),
    }
    this.secureContext = tls.createSecureContext(this.ssl)
  }

  options({ context, negotiation }) {
    return {
      ssl: { ...this.ssl, ...(context === 'shared' ? { secureContext: this.secureContext } : {}) },
      sslnegotiation: negotiation,
    }
  }

  assertConnection({ client, negotiation }) {
    const socket = client.connection.stream
    assert.equal(socket.encrypted, true)
    assert.equal(socket.authorized, true)
    assert.equal(socket.getProtocol(), 'TLSv1.3')
    if (negotiation === 'direct') assert.equal(socket.alpnProtocol, 'postgresql')
  }
}

const createTlsConfig = () => new BenchmarkTlsConfig()

const assertFrontendCache = ({ client, min, max }) => {
  // Transaction poolers rewrite backend names; the bound belongs to this frontend connection.
  const count = client._autoPreparedStatements?.size ?? 0
  assert.ok(count >= min && count <= max, `expected ${min}..${max} frontend statements, got ${count}`)
}

class TlsWorkload {
  constructor({ pg, profile, arm }) {
    assert.ok(['tls-handshake', 'tls-steady'].includes(profile))
    assert.ok(Number.isInteger(arm) && arm >= 0 && arm < 4)
    this.pg = pg
    this.tls = createTlsConfig()
    this.all = {}
    this.clients = []
    this.pools = []
    if (profile === 'tls-handshake') {
      this.addHandshake({
        name: 'fresh context vs shared context',
        context: arm % 2 === 0 ? 'fresh' : 'shared',
        negotiation: 'postgres',
      })
      this.addHandshake({
        name: 'postgres vs direct negotiation',
        context: 'shared',
        negotiation: arm % 2 === 0 ? 'postgres' : 'direct',
      })
    } else {
      this.addSteady('parameterized SELECT x16')
      this.addSteady('fresh SQL SELECT x16')
      this.addSteady('simple SELECT 1 x16')
      this.addSteady('bytea 2 x 1 MiB')
    }
  }

  consume({ result, expected }) {
    assert.equal(result.rowCount, 1)
    assert.equal(result.rows.length, 1)
    assert.equal(result.rows[0].n, expected)
  }

  addHandshake({ name, context, negotiation }) {
    const options = this.tls.options({ context, negotiation })
    this.all[`TLS handshake, ${name}`] = async () => {
      const client = new this.pg.Client(options)
      try {
        await client.connect()
        this.tls.assertConnection({ client, negotiation })
        this.consume({ result: await client.query('SELECT 17 AS n'), expected: 17 })
      } finally {
        await client.end()
      }
      return 1
    }
  }

  addSteady(mode) {
    const client = new this.pg.Client({
      pipeline: true,
      maxAutoPrepare: 16,
      ...this.tls.options({ context: 'shared', negotiation: 'direct' }),
    })
    this.clients.push(client)
    const fixtures =
      mode === 'bytea 2 x 1 MiB'
        ? Array.from({ length: 2 }, () => ({
            config: { text: 'SELECT octet_length($1::bytea) AS n', values: [Buffer.alloc(1048576, 0x61)] },
            expected: 1048576,
          }))
        : Array.from({ length: 16 }, (_, value) => ({
            config:
              mode === 'simple SELECT 1 x16'
                ? { text: 'SELECT 1 AS n' }
                : { text: 'SELECT $1::int AS n', values: [value] },
            expected: mode === 'simple SELECT 1 x16' ? 1 : value,
          }))
    let serial = 0
    const run = async () => {
      const results = await Promise.all(
        fixtures.map(({ config }) =>
          client.query(
            mode === 'fresh SQL SELECT x16' ? { ...config, text: `${config.text} -- tls_${serial++}` } : config
          )
        )
      )
      assert.equal(results.length, fixtures.length)
      for (let i = 0; i < results.length; i++) this.consume({ result: results[i], expected: fixtures[i].expected })
      return fixtures.length
    }
    run.prepare = async () => {
      await run()
      this.tls.assertConnection({ client, negotiation: 'direct' })
      assert.equal(client.getTransactionStatus(), 'I')
      assertFrontendCache({ client, min: mode === 'simple SELECT 1 x16' ? 0 : 1, max: 16 })
    }
    this.all[`TLS steady, ${mode}`] = run
  }
}

const createTlsWorkload = async ({ pg, profile, arm }) => {
  const workload = new TlsWorkload({ pg, profile, arm })
  await Promise.all(workload.clients.map((client) => client.connect()))
  return { all: workload.all, clients: workload.clients, pools: workload.pools }
}

module.exports = { createTlsWorkload, createTlsConfig, assertFrontendCache }
