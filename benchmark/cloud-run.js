'use strict'

const assert = require('assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync, spawnSync } = require('child_process')

class CloudRun {
  constructor({ base, head, output, mode }) {
    assert.ok(['measure', 'smoke'].includes(mode))
    this.base = path.resolve(base)
    this.head = path.resolve(head)
    this.output = path.resolve(output)
    this.mode = mode
    this.results = []
    fs.mkdirSync(this.output, { recursive: true })
  }

  snapshot() {
    const read = (name) => {
      try {
        return fs.readFileSync(name, 'utf8')
      } catch {
        return null
      }
    }
    return {
      time: new Date().toISOString(),
      load: os.loadavg(),
      freeMemory: os.freemem(),
      totalMemory: os.totalmem(),
      cpu: os.cpus()[0]?.model,
      cores: os.cpus().length,
      platform: os.platform(),
      kernel: os.release(),
      virtualization: read('/sys/class/dmi/id/product_name'),
      pressure: {
        cpu: read('/proc/pressure/cpu'),
        io: read('/proc/pressure/io'),
        memory: read('/proc/pressure/memory'),
      },
      disk: read('/proc/diskstats'),
    }
  }

  identity(directory) {
    const git = (ref) => execFileSync('git', ['-C', directory, 'rev-parse', ref], { encoding: 'utf8' }).trim()
    return { commit: git('HEAD'), tree: git('HEAD^{tree}') }
  }

  async inspectDatabase() {
    const pg = require(path.join(this.head, 'packages/pg'))
    const client = new pg.Client()
    try {
      await client.connect()
      const settings = (
        await client.query(
          "SELECT version(), current_setting('fsync') AS fsync, current_setting('full_page_writes') AS full_page_writes, current_setting('synchronous_commit') AS synchronous_commit, current_setting('checkpoint_timeout') AS checkpoint_timeout"
        )
      ).rows[0]
      assert.equal(settings.fsync, 'on')
      assert.equal(settings.full_page_writes, 'on')
      assert.equal(settings.synchronous_commit, 'on')
      return settings
    } finally {
      await client.end()
    }
  }

  runPhase(phase) {
    const before = this.snapshot()
    const base = phase.profile === 'executor' ? this.head : this.base
    const stem = path.join(this.output, phase.name)
    const measured = this.mode === 'measure'
    const command = [
      path.join(__dirname, 'compare.js'),
      '--base',
      base,
      '--head',
      this.head,
      '--profile',
      phase.profile,
      '--scenario',
      phase.scenario,
      '--rounds',
      String(measured ? phase.rounds : 1),
      '--duration',
      String(measured ? phase.duration : 0.02),
      '--warmup',
      String(measured ? 2 : 0.02),
      '--output',
      stem + '.md',
      '--json-output',
      stem + '.json',
    ]
    const result = spawnSync(process.execPath, command, {
      env: {
        ...process.env,
        PG_BENCH_CHECKPOINT: '1',
        PG_BENCH_TLS_CA: phase.tls ? process.env.PG_HA_TLS_CA : undefined,
        PG_BENCH_DELAY_MS: phase.tls ? '3' : undefined,
        PG_BENCH_ENDPOINT: phase.tls ? 'GitHub VM, verified TLS1.3, relay3ms/direction' : 'GitHub VM, PostgreSQL TCP',
      },
      encoding: 'utf8',
      timeout: 600000,
      maxBuffer: 1048576,
    })
    fs.writeFileSync(stem + '.log', (result.stdout || '') + (result.stderr || ''))
    assert.equal(result.error, undefined)
    assert.equal(result.status, 0, result.stderr)
    const report = JSON.parse(fs.readFileSync(stem + '.json', 'utf8'))
    assert.deepEqual(report.checkouts, { base: this.identity(base), head: this.identity(this.head) })
    assert.equal(report.rows.length, 1)
    for (const samples of Object.values(report.rows[0].samples)) {
      assert.equal(samples.length, report.rounds)
      assert.ok(samples.every((value) => Number.isFinite(value) && value > 0))
    }
    const row = report.rows[0]
    const quality = row.noise <= 0.1 ? 'within 10% control band' : 'inconclusive: controls exceed 10%'
    this.results.push({ name: phase.name, quality, report, before, after: this.snapshot() })
    fs.writeFileSync(path.join(this.output, 'run.json'), JSON.stringify(this.summary, null, 2) + '\n')
    process.stdout.write(
      phase.name + ': ' + row.speedup.toFixed(3) + 'x, noise ' + (row.noise * 100).toFixed(1) + '%, ' + quality + '\n'
    )
  }

  get summary() {
    return {
      mode: this.mode,
      runId: process.env.GITHUB_RUN_ID || null,
      runAttempt: process.env.GITHUB_RUN_ATTEMPT || null,
      job: process.env.GITHUB_JOB || null,
      node: process.version,
      database: this.database,
      results: this.results,
    }
  }

  async run() {
    this.database = await this.inspectDatabase()
    for (const phase of [
      {
        name: 'overhead-update',
        profile: 'executor-regression',
        scenario: 'logged UPDATE, 16 concurrent',
        rounds: 8,
        duration: 5,
      },
      {
        name: 'tls-concurrent',
        profile: 'executor',
        scenario: 'independent SELECT, 16 concurrent',
        rounds: 4,
        duration: 3,
        tls: true,
      },
      {
        name: 'tls-sequential',
        profile: 'executor',
        scenario: 'independent SELECT, sequential',
        rounds: 4,
        duration: 3,
        tls: true,
      },
    ])
      this.runPhase(phase)
    const lines = [
      '## Reproducible benchmark',
      '',
      '| Case | Ratio | Control noise | Quality |',
      '| --- | ---: | ---: | --- |',
    ]
    for (const { name, report, quality } of this.results) {
      const row = report.rows[0]
      lines.push(
        '| ' + name + ' | ' + row.speedup.toFixed(3) + 'x | ' + (row.noise * 100).toFixed(1) + '% | ' + quality + ' |'
      )
    }
    lines.push(
      '',
      'Raw rounds and host metadata are in the artifact. A green job means execution/assertions passed, not a proven speedup.'
    )
    fs.writeFileSync(path.join(this.output, 'summary.md'), lines.join('\n') + '\n')
  }
}

new CloudRun({
  base: process.argv[2],
  head: process.argv[3],
  output: process.argv[4],
  mode: process.argv[5] || 'measure',
})
  .run()
  .catch((error) => {
    process.stderr.write(String(error.stack || error) + '\n')
    process.exitCode = 1
  })
