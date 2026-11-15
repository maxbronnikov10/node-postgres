'use strict'

const assert = require('assert/strict')
const { ProductionLoad, ProductionBenchmark } = require('./production-load')

async function main() {
  const kinds = { point: 0, range: 0, write: 0, transaction: 0 }
  for (let index = 0; index < 100; index++) kinds[ProductionLoad.operation(index).kind]++
  assert.deepEqual(kinds, { point: 70, range: 20, write: 8, transaction: 2 })
  assert.throws(() => ProductionBenchmark.arguments(['--rate', '0']))
  assert.throws(() => ProductionBenchmark.arguments(['--seconds', '1801']))
  assert.throws(() => ProductionBenchmark.arguments(['--driver', 'invalid']))
  assert.throws(() => ProductionBenchmark.arguments(['--rate', '1.5']))
  let attempts = 0
  const target = {
    async run() {
      const attempt = ++attempts
      await new Promise((resolve) => setTimeout(resolve, 20))
      if (attempt <= 2)
        throw Object.assign(new Error('fake overload'), { code: 'PG_EXECUTOR_OVERLOADED', outcome: 'not-sent' })
    },
  }
  const result = await new ProductionLoad({ target, rate: 1000, seconds: 1, cap: 2 }).run()
  assert.equal(result.offered, 1000)
  assert.equal(result.completed + result.failed + result.schedulerRejections.count, 1000)
  assert.ok(result.completed > 0)
  assert.ok(result.failed > 0)
  assert.ok(result.schedulerRejections.count > 0)
  assert.equal(result.successLatency.count, result.completed)
  assert.equal(result.failureLatency.count, result.failed)
  assert.equal(result.schedulerRejections.latency.count, result.schedulerRejections.count)
  assert.equal(result.peakOutstanding, 2)
  assert.equal(result.schedulerRejections.outcome, 'not-sent')
  assert.ok(result.successLatency.maxMillis >= 20)
  console.log(
    JSON.stringify({
      check: 'production-load accounting, latency, mix and input bounds',
      passed: true,
      offered: result.offered,
      completed: result.completed,
      failed: result.failed,
      schedulerRejected: result.schedulerRejections.count,
    })
  )
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
