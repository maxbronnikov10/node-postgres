'use strict'

const assert = require('assert/strict')
const { EventEmitter } = require('events')
const path = require('path')
const { spawnSync } = require('child_process')

// Only the transport is fake; acquisition, timeout removal and release run in each checkout's Pool.
class QueueClient extends EventEmitter {
  constructor() {
    super()
    this._queryable = true
  }

  connect(callback) {
    process.nextTick(callback)
  }

  end(callback) {
    this._ending = true
    process.nextTick(() => {
      this.emit('end')
      if (callback) callback()
    })
  }
}

const assertEmpty = (pool) => {
  assert.equal(pool.waitingCount, 0)
  // Check retained queue storage as well as the public counter in both implementations.
  if ('_pendingQueue' in pool) assert.equal(pool._pendingQueue.length, 0)
  if ('_pendingQueueHead' in pool) {
    assert.equal(pool._pendingQueueHead, undefined)
    assert.equal(pool._pendingQueueTail, undefined)
  }
}

const createQueueScenarios = (Pool) => {
  const scenarios = {}
  const pools = []
  for (const depth of [10, 1000, 10000]) {
    for (const mode of ['FIFO drain', 'timeout churn']) {
      const pool = new Pool({ Client: QueueClient, max: 1, idleTimeoutMillis: 0 })
      pools.push(pool)
      scenarios[`pool queue, depth ${depth}, ${mode}`] = async () => {
        const held = await pool.connect()
        assert.equal(pool.totalCount, 1)
        assert.equal(pool.idleCount, 0)
        const expired = []
        const pending = []
        let next = 0
        // Interleave timed-out and surviving waiters, exercising removal inside the queue.
        for (let i = 0; i < depth; i++) {
          const timeout = mode === 'timeout churn' && i % 2 === 0
          pool.options.connectionTimeoutMillis = timeout ? 1 : 0
          if (timeout) {
            expired.push(
              pool.connect().then(
                (client) => {
                  client.release()
                  assert.fail('waiter should time out while the only client is held')
                },
                (error) => assert.equal(error.message, 'timeout exceeded when trying to connect')
              )
            )
          } else {
            const position = next++
            pending.push(
              pool.connect().then((client) => {
                try {
                  assert.equal(client, held)
                  assert.equal(position, served++)
                } finally {
                  client.release()
                }
              })
            )
          }
        }
        pool.options.connectionTimeoutMillis = 0
        assert.equal(pool.waitingCount, depth)
        let served = 0
        if (expired.length) {
          // Pool timers are unref'd. Keep this isolated, database-free workload alive until they fire.
          const keepAlive = setInterval(() => {}, 1000)
          try {
            await Promise.all(expired)
          } finally {
            clearInterval(keepAlive)
          }
          assert.equal(pool.waitingCount, pending.length)
        }
        held.release()
        await Promise.all(pending)
        assert.equal(served, pending.length)
        assertEmpty(pool)
        assert.equal(pool.totalCount, 1)
        assert.equal(pool.idleCount, 1)
        const reused = await pool.connect()
        assert.equal(reused, held)
        reused.release()
        assertEmpty(pool)
        // One operation = one queued checkout, including a checkout settled by timeout.
        return depth
      }
    }
  }
  return { scenarios, pools }
}

module.exports = { createQueueScenarios, assertEmpty }

if (require.main === module) {
  const { parseArgs } = require('./compare')
  assert.deepEqual(parseArgs(['--base', '.', '--head', '.', '--profile', 'queue']), {
    base: '.',
    head: '.',
    profile: 'queue',
  })
  assert.throws(() => parseArgs(['--profile']), /missing value/)
  assert.throws(() => parseArgs(['--profile', '--base', '.']), /missing value/)
  assert.throws(() => parseArgs(['--unknown', 'queue']), /unknown argument/)
  assert.throws(() => parseArgs(['queue']), /unknown argument/)
  const root = path.resolve(process.argv[2] || path.join(__dirname, '..'))
  for (const profile of ['autocommit-prepare', 'autocommit-pipeline', 'tls-handshake', 'row-formats', 'executor']) {
    const mismatch = spawnSync(
      process.execPath,
      [path.join(__dirname, 'compare.js'), '--base', root, '--head', path.dirname(root), '--profile', profile],
      { encoding: 'utf8', timeout: 5000 }
    )
    assert.equal(mismatch.error, undefined)
    assert.equal(mismatch.status, 1)
    assert.match(mismatch.stderr, /requires --base and --head to name the same checkout/)
  }
  const Pool = require(path.join(root, 'packages/pg-pool'))
  const { scenarios, pools } = createQueueScenarios(Pool)
  ;(async () => {
    for (const run of Object.values(scenarios)) await run()
    for (const pool of pools) {
      await pool.end()
      assertEmpty(pool)
      assert.equal(pool.totalCount, 0)
      assert.equal(pool.idleCount, 0)
    }
    // A startup failure must reject promptly and leave no sibling holding inherited output pipes open.
    const failed = spawnSync(
      process.execPath,
      [
        path.join(__dirname, 'compare.js'),
        '--base',
        path.join(root, 'missing-benchmark-checkout'),
        '--head',
        root,
        '--profile',
        'queue',
      ],
      { encoding: 'utf8', timeout: 5000 }
    )
    assert.equal(failed.error, undefined)
    assert.equal(failed.status, 1)
    assert.match(failed.stderr, /Cannot find module/)
    assert.doesNotMatch(failed.stderr, /UnhandledPromiseRejection/)
    process.stdout.write('CLI parsing, worker startup cleanup and queue lifecycle self-check: 6 scenarios passed\n')
  })().catch((error) => {
    process.stderr.write(`${error.stack}\n`)
    process.exit(1)
  })
}
