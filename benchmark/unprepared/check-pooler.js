'use strict'

const fs = require('node:fs')
const assert = require('node:assert/strict')
const { Client } = require('../../packages/pg')

async function check() {
  const client = new Client({
    database: 'pgbouncer',
    ssl: {
      ca: fs.readFileSync(process.env.PG_BENCH_TLS_CA),
      rejectUnauthorized: true,
      minVersion: 'TLSv1.3',
      maxVersion: 'TLSv1.3',
    },
  })
  try {
    await client.connect()
    assert.equal(client.connection.stream.getProtocol(), 'TLSv1.3')
    const { rows } = await client.query('SHOW CONFIG')
    const settings = Object.fromEntries(rows.map(({ key, value }) => [key, value]))
    const expected = {
      pool_mode: 'transaction',
      max_prepared_statements: '0',
      default_pool_size: '4',
      client_tls_sslmode: 'require',
      client_tls_protocols: 'tlsv1.3',
      server_tls_sslmode: 'verify-full',
      server_tls_protocols: 'tlsv1.3',
    }
    for (const [key, value] of Object.entries(expected)) assert.equal(settings[key], value, key)
    fs.writeFileSync(process.argv[2], JSON.stringify({ verified: expected, frontendTls: 'TLSv1.3' }, null, 2) + '\n')
    console.log('PASS: live transaction pool, tracking disabled, four backends, verified TLS')
  } finally {
    await client.end()
  }
}

check().catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})
