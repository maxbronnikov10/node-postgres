'use strict'

const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const { createHash } = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

// Serialized into the consumer so both require() and import() resolve its real installation.
async function checkConsumer() {
  const assert = require('node:assert/strict')
  const fs = require('node:fs')
  const path = require('node:path')
  const { createRequire } = require('node:module')
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'artifacts.json'), 'utf8'))
  for (const name of manifest.defaultInstall) {
    const directory = path.join(__dirname, 'node_modules', name)
    assert.equal(fs.lstatSync(directory).isSymbolicLink(), false, `${name} must not link to checkout`)
    const installed = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'))
    assert.equal(installed.version, manifest.packages[name].version)
    const localRequire = createRequire(path.join(directory, 'package.json'))
    for (const section of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
      for (const dependency of Object.keys(installed[section] || {})) {
        if (!manifest.packages[dependency]) continue
        assert.equal(installed[section][dependency], manifest.packages[dependency].version)
        if (dependency === 'pg-native') {
          assert.equal(installed.peerDependenciesMeta[dependency].optional, true)
          continue
        }
        const entry = localRequire.resolve(dependency)
        assert.ok(
          entry.startsWith(directory + path.sep) || entry.startsWith(path.join(__dirname, 'node_modules') + path.sep)
        )
        assert.equal(fs.realpathSync(entry), entry, 'Resolved dependency must not link to checkout')
      }
    }
    const cjs = require(name)
    const esm = await import(name)
    assert.ok(cjs)
    assert.ok(esm.default)
    if (name === 'pg') {
      assert.equal(esm.QueryExecutor, cjs.QueryExecutor)
      assert.equal(esm.QueryExecutorError, cjs.QueryExecutorError)
    }
    if (name === 'pg-protocol') {
      assert.equal(typeof cjs.parseRaw, 'function')
      assert.equal(esm.parseRaw, cjs.parseRaw)
    }
  }
  assert.equal(fs.existsSync(path.join(__dirname, 'node_modules', 'pg-native')), false)
  const pg = require('pg')
  const Cursor = require('pg-cursor')
  const QueryStream = require('pg-query-stream')
  const options = { connectionTimeoutMillis: 5000, query_timeout: 10000 }
  const executor = new pg.QueryExecutor({ ...options, max: 1, maxResultRows: 2 })
  const client = new pg.Client(options)
  const deadline = setTimeout(() => {
    console.error('Consumer check exceeded 45 seconds')
    process.exit(1)
  }, 45000)
  try {
    await assert.rejects(executor.query('SELECT generate_series(1, 3) AS value'), {
      code: 'PG_EXECUTOR_RESULT_LIMIT',
    })
    assert.deepEqual((await executor.query('SELECT 42::int AS value')).rows, [{ value: 42 }])
    await client.connect()
    assert.deepEqual(
      (await client.query({ text: 'SELECT $1::int4 AS value', values: [-16909061], binary: true })).rows,
      [{ value: -16909061 }]
    )
    const cursor = client.query(new Cursor('SELECT generate_series(1, 3) AS value'))
    try {
      assert.deepEqual(await cursor.read(2), [{ value: 1 }, { value: 2 }])
      assert.deepEqual(await cursor.read(2), [{ value: 3 }])
      assert.deepEqual(await cursor.read(2), [])
    } finally {
      await cursor.close()
    }
    const rows = []
    for await (const row of client.query(
      new QueryStream('SELECT generate_series(1, 3) AS value', [], { batchSize: 2 })
    )) {
      rows.push(row)
    }
    assert.deepEqual(rows, [{ value: 1 }, { value: 2 }, { value: 3 }])
    console.log(
      'PASS: isolated versions, no source links, CJS/ESM, executor recovery, binary int4, cursor, query-stream'
    )
  } finally {
    await Promise.allSettled([executor.end(), client.end()])
    clearTimeout(deadline)
  }
}

class PackageChecker {
  check() {
    assert.equal(
      process.argv.length,
      4,
      'Usage: node benchmark/package-check.js ARTIFACT_DIRECTORY FRESH_CONSUMER_DIRECTORY'
    )
    for (const name of ['PGHOST', 'PGPORT', 'PGUSER', 'PGDATABASE'])
      assert.ok(process.env[name], `Set ${name} explicitly`)
    const artifacts = path.resolve(process.argv[2])
    const consumer = path.resolve(process.argv[3])
    assert.equal(fs.existsSync(consumer), false, 'Consumer directory must not exist')
    const manifest = JSON.parse(fs.readFileSync(path.join(artifacts, 'manifest.json'), 'utf8'))
    const names = [
      'pg',
      'pg-protocol',
      'pg-pool',
      'pg-cursor',
      'pg-query-stream',
      'pg-connection-string',
      'pg-cloudflare',
    ]
    assert.deepEqual(manifest.defaultInstall, names)
    assert.deepEqual(Object.keys(manifest.packages), [...names, 'pg-native'])
    for (const record of Object.values(manifest.packages)) {
      assert.equal(path.basename(record.filename), record.filename)
      assert.match(record.filename, /^[a-z0-9.-]+\.tgz$/)
      assert.equal(
        createHash('sha256')
          .update(fs.readFileSync(path.join(artifacts, record.filename)))
          .digest('hex'),
        record.sha256,
        `Artifact hash mismatch: ${record.filename}`
      )
    }
    fs.mkdirSync(consumer, { recursive: true })
    fs.writeFileSync(
      path.join(consumer, 'package.json'),
      JSON.stringify({ name: 'nodepg-package-consumer', private: true })
    )
    fs.writeFileSync(path.join(consumer, 'artifacts.json'), JSON.stringify(manifest, null, 2) + '\n')
    execFileSync(
      'npm',
      [
        'install',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        '--prefer-offline',
        ...names.map((name) => path.join(artifacts, manifest.packages[name].filename)),
      ],
      { cwd: consumer, stdio: 'inherit', timeout: 120000 }
    )
    const check = path.join(consumer, 'check.cjs')
    fs.writeFileSync(
      check,
      `(${checkConsumer.toString()})().catch(error => { console.error(error); process.exitCode = 1 })\n`
    )
    execFileSync(process.execPath, [check], { cwd: consumer, stdio: 'inherit', timeout: 60000 })
  }
}

try {
  new PackageChecker().check()
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
