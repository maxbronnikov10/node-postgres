'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const inspector = require('node:inspector')
const { performance } = require('node:perf_hooks')
const { createPostgresJsWorkload } = require('./postgresjs')

class ProfileSummary {
  static from(profile) {
    const nodes = new Map(profile.nodes.map((node) => [node.id, node.callFrame]))
    const frames = new Map()
    let idleSamples = 0
    for (const id of profile.samples) {
      const frame = nodes.get(id)
      assert.ok(frame, 'profile sample must reference an existing node')
      if (frame.functionName === '(idle)') {
        idleSamples++
        continue
      }
      const source = frame.url ? frame.url.split('/').slice(-2).join('/') : '(generated)'
      const key = JSON.stringify([frame.functionName || '(anonymous)', source, frame.lineNumber + 1])
      frames.set(key, (frames.get(key) || 0) + 1)
    }
    return {
      totalSamples: profile.samples.length,
      activeSamples: profile.samples.length - idleSamples,
      frames: [...frames]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 50)
        .map(([key, samples]) => {
          const [name, source, line] = JSON.parse(key)
          return { name, source, line, samples }
        }),
    }
  }
}

class ClientProfile {
  session = new inspector.Session()

  post(method) {
    return new Promise((resolve, reject) => {
      this.session.post(method, (error, result) => (error ? reject(error) : resolve(result)))
    })
  }

  async run({ arm, scenario }) {
    assert.ok(arm === 0 || arm === 1)
    const workload = await createPostgresJsWorkload({ pg: require('../packages/pg'), arm })
    try {
      await workload.setup()
      await workload.prepare()
      const run = workload.all[scenario]
      assert.equal(typeof run, 'function', 'unknown profiling scenario')
      const warmup = performance.now()
      while (performance.now() - warmup < 2000) await run()
      this.session.connect()
      await this.post('Profiler.enable')
      await this.post('Profiler.start')
      const cpu = process.cpuUsage()
      const started = performance.now()
      let completed = 0
      while (performance.now() - started < 20000) completed += await run()
      const elapsedMillis = performance.now() - started
      const usage = process.cpuUsage(cpu)
      const { profile } = await this.post('Profiler.stop')
      assert.ok(completed > 0)
      return {
        arm,
        scenario,
        completed,
        elapsedMillis,
        clientCpuMicrosPerOperation: (usage.user + usage.system) / completed,
        cpu: usage,
        heapUsed: process.memoryUsage().heapUsed,
        profile: ProfileSummary.from(profile),
      }
    } finally {
      this.session.disconnect()
      await Promise.all(workload.pools.map((pool) => pool.end()))
    }
  }
}

if (require.main === module) {
  const output = process.argv[4]
  assert.equal(typeof output, 'string')
  new ClientProfile()
    .run({ arm: Number(process.argv[2]), scenario: process.argv[3] })
    .then((result) => {
      fs.mkdirSync(path.dirname(output), { recursive: true })
      fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n')
    })
    .catch((error) => {
      console.error(error)
      process.exitCode = 1
    })
}

module.exports = { ProfileSummary }
