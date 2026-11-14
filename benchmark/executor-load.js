'use strict'

const assert = require('assert/strict')
const path = require('path')
const { createHistogram, monitorEventLoopDelay, performance } = require('perf_hooks')
const { createExecutorWorkload } = require('./executor')

class OfferedLoad {
  constructor({ workload, rate, seconds, maxPending }) {
    this.workload = workload
    this.rate = rate
    this.seconds = seconds
    this.count = rate * seconds
    this.maxPending = maxPending
    this.success = createHistogram()
    this.rejection = createHistogram()
    this.loopDelay = monitorEventLoopDelay({ resolution: 10 })
    this.completed = 0
    this.rejected = 0
    this.outstanding = 0
    this.peakWaiting = 0
    this.peakInFlight = 0
    this.startHeap = process.memoryUsage().heapUsed
    this.peakHeap = this.startHeap
    this.errors = Object.create(null)
  }

  sample() {
    const resource = this.workload.resource
    this.peakWaiting = Math.max(this.peakWaiting, resource.waitingCount)
    const inFlight = resource.inFlightCount ?? resource.totalCount - resource.idleCount
    this.peakInFlight = Math.max(this.peakInFlight, inFlight)
    this.peakHeap = Math.max(this.peakHeap, process.memoryUsage().heapUsed)
    if (this.workload.arm % 2) {
      assert.ok(resource.waitingCount <= this.maxPending)
      assert.ok(resource.inFlightCount <= 64)
    }
  }

  dispatch(index) {
    this.outstanding++
    const intended = this.started + (index * 1000) / this.rate
    // Latency starts at intended arrival, including scheduler lag and queue wait.
    this.workload.query().then(
      () => {
        this.completed++
        this.success.record(Math.max(1, Math.round((performance.now() - intended) * 1000)))
        this.settled()
      },
      (error) => {
        this.rejected++
        this.rejection.record(Math.max(1, Math.round((performance.now() - intended) * 1000)))
        const key = `${error.code}/${error.outcome}`
        this.errors[key] = (this.errors[key] || 0) + 1
        this.settled()
      }
    )
  }

  settled() {
    this.outstanding--
    if (this.generated === this.count && this.outstanding === 0) this.resolveDrained()
  }

  generate() {
    const target = Math.min(this.count, Math.floor(((performance.now() - this.started) * this.rate) / 1000) + 1)
    while (this.generated < target) this.dispatch(this.generated++)
    this.sample()
    if (this.generated < this.count) {
      const next = this.started + (this.generated * 1000) / this.rate
      this.timer = setTimeout(() => this.generate(), Math.max(1, next - performance.now()))
    } else {
      this.generationMillis = performance.now() - this.started
      this.completedAtWindowEnd = this.completed
      if (!this.outstanding) this.resolveDrained()
    }
  }

  stats(histogram) {
    return {
      count: histogram.count,
      p50Millis: histogram.percentile(50) / 1000,
      p95Millis: histogram.percentile(95) / 1000,
      p99Millis: histogram.percentile(99) / 1000,
      maxMillis: histogram.max / 1000,
    }
  }

  async run() {
    this.generated = 0
    this.loopDelay.enable()
    this.started = performance.now()
    const drained = new Promise((resolve) => {
      this.resolveDrained = resolve
    })
    const sampler = setInterval(() => this.sample(), 50)
    // A broken transport must not turn a benchmark into an endless drain.
    const deadline = setTimeout(
      () => {
        this.failure = new Error('offered-load drain exceeded 30 seconds')
        if (this.workload.arm % 2) this.workload.resource.destroy(this.failure)
        this.resolveDrained()
      },
      this.seconds * 1000 + 30000
    )
    try {
      this.generate()
      await drained
      if (this.failure) throw this.failure
      this.sample()
      this.workload.assertIdle()
      assert.equal(this.completed + this.rejected, this.count)
      return {
        arm: this.workload.arm % 2 ? 'QueryExecutor' : 'Pool.query',
        offeredPerSecond: this.rate,
        offeredSeconds: this.seconds,
        offered: this.count,
        generationMillis: this.generationMillis,
        completedAtWindowEnd: this.completedAtWindowEnd,
        completed: this.completed,
        rejected: this.rejected,
        errors: this.errors,
        drainMillis: performance.now() - this.started - this.generationMillis,
        successLatency: this.stats(this.success),
        rejectionLatency: this.stats(this.rejection),
        peakWaiting: this.peakWaiting,
        peakInFlight: this.peakInFlight,
        observedHeapGrowthBytes: this.peakHeap - this.startHeap,
        eventLoopP99Millis: this.loopDelay.percentile(99) / 1e6,
      }
    } finally {
      clearTimeout(this.timer)
      clearTimeout(deadline)
      clearInterval(sampler)
      this.loopDelay.disable()
    }
  }
}

const main = async () => {
  const pg = require(path.join(path.resolve(process.argv[2] || '.'), 'packages/pg'))
  const kind = process.argv[3] || 'executor'
  assert.ok(['pool', 'executor'].includes(kind))
  const rate = Number(process.env.PG_BENCH_LOAD_RATE || 1000)
  const seconds = Number(process.env.PG_BENCH_LOAD_SECONDS || 5)
  const maxPending = Number(process.env.PG_BENCH_LOAD_PENDING || 64)
  assert.ok(Number.isSafeInteger(rate) && rate > 0 && rate <= 100000)
  assert.ok(Number.isSafeInteger(seconds) && seconds > 0 && seconds <= 30)
  assert.ok(Number.isSafeInteger(maxPending) && maxPending > 0 && maxPending <= 65536)
  const { workload } = await createExecutorWorkload({ pg, arm: kind === 'pool' ? 0 : 1, maxPending })
  try {
    await workload.setup()
    await workload.prepare()
    global.gc?.()
    const result = await new OfferedLoad({ workload, rate, seconds, maxPending }).run()
    process.stdout.write(`${JSON.stringify(result)}\n`)
  } finally {
    await workload.end()
  }
}

if (require.main === module)
  main().catch((error) => {
    process.stderr.write(`${error.stack || error}\n`)
    process.exit(1)
  })

module.exports = { OfferedLoad }
