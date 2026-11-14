'use strict'

const EventEmitter = require('events').EventEmitter
const expect = require('expect.js')

const describe = require('mocha').describe
const it = require('mocha').it

const Pool = require('../')

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))

class ImmediateClient extends EventEmitter {
  constructor() {
    super()
    this._connected = false
    this._queryable = true
    this._ending = false
  }

  connect(callback) {
    process.nextTick(() => {
      this._connected = true
      callback()
    })
  }

  isConnected() {
    return this._connected
  }

  end(callback) {
    this._ending = true
    this._connected = false
    this._queryable = false
    process.nextTick(() => {
      this.emit('end')
      if (callback) callback()
    })
  }

  ref() {}

  unref() {}
}

class DequeuedClient extends ImmediateClient {
  static connectionCount = 0

  constructor() {
    super()
    this.connection = { stream: { destroy: () => {} } }
  }

  connect(callback) {
    DequeuedClient.connectionCount += 1
    if (DequeuedClient.connectionCount === 1) {
      return setImmediate(() => callback(new Error('first connection failed')))
    }

    return setTimeout(() => {
      this._connected = true
      callback()
    }, 60)
  }
}

function queuedCheckout(pool, order, label) {
  return new Promise((resolve, reject) => {
    pool.connect((err, client, release) => {
      if (err) {
        reject(err)
        return
      }
      order.push(label)
      resolve({ client, release })
    })
  })
}

describe('pending checkout queue', () => {
  it('removes timed out entries and preserves FIFO for survivors', async () => {
    const pool = new Pool({ Client: ImmediateClient, max: 1, idleTimeoutMillis: 0 })
    const held = await pool.connect()
    const order = []

    const first = queuedCheckout(pool, order, 'first')

    // Use a shorter timeout for the middle entry so both neighboring entries remain queued.
    pool.options.connectionTimeoutMillis = 20
    const timedOut = pool.connect().then(
      () => {
        throw new Error('timed out checkout unexpectedly succeeded')
      },
      (err) => err
    )
    pool.options.connectionTimeoutMillis = 0

    const third = queuedCheckout(pool, order, 'third')
    const fourth = queuedCheckout(pool, order, 'fourth')

    const timeoutError = await timedOut
    expect(timeoutError.message).to.be('timeout exceeded when trying to connect')
    expect(pool.waitingCount).to.be(3)

    held.release()
    const firstLease = await first
    firstLease.release()
    const thirdLease = await third
    thirdLease.release()
    const fourthLease = await fourth
    fourthLease.release()

    expect(order).to.eql(['first', 'third', 'fourth'])
    expect(pool.waitingCount).to.be(0)
    await pool.end()
  })

  it('reuses queue after it becomes empty', async () => {
    const pool = new Pool({ Client: ImmediateClient, max: 1, idleTimeoutMillis: 0 })
    const first = await pool.connect()
    first.release()

    expect(pool.waitingCount).to.be(0)
    const second = await pool.connect()
    expect(second).to.be(first)
    second.release()
    await pool.end()
  })

  it('releases a client when a dequeued checkout times out during connect', async () => {
    DequeuedClient.connectionCount = 0
    const pool = new Pool({ Client: DequeuedClient, max: 1, connectionTimeoutMillis: 20, idleTimeoutMillis: 0 })

    const firstError = pool.connect().then(
      () => {
        throw new Error('first checkout unexpectedly succeeded')
      },
      (err) => err
    )
    let calls = 0
    const queuedError = new Promise((resolve) =>
      pool.connect((err) => {
        calls++
        resolve(err)
      })
    )

    expect((await firstError).message).to.be('first connection failed')
    expect((await queuedError).message).to.be('timeout exceeded when trying to connect')
    expect(pool.waitingCount).to.be(0)

    await wait(80)
    expect(calls).to.be(1)
    expect(pool.idleCount).to.be(1)
    const reusable = await pool.connect()
    reusable.release()
    await pool.end()
  })
})
