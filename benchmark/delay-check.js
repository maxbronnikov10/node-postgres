'use strict'

const assert = require('assert')
const net = require('net')
const { once } = require('events')
const { performance } = require('perf_hooks')
const { DelayedProxy } = require('./delayed-proxy')

class EchoCheck {
  constructor() {
    this.sockets = new Set()
    this.proxies = []
    this.server = net.createServer({ allowHalfOpen: true }, (socket) => {
      this.sockets.add(socket)
      socket.on('close', () => this.sockets.delete(socket))
      socket.on('error', () => socket.destroy())
      socket.pipe(socket)
    })
  }

  async start() {
    this.server.listen(0, '127.0.0.1')
    await once(this.server, 'listening')
    this.port = this.server.address().port
  }

  async proxy(options) {
    const proxy = await new DelayedProxy({ host: '127.0.0.1', port: this.port, ...options }).start()
    this.proxies.push(proxy)
    return proxy
  }

  async client(port) {
    const socket = net.createConnection({ host: '127.0.0.1', port })
    this.sockets.add(socket)
    socket.on('close', () => this.sockets.delete(socket))
    socket.setNoDelay(true)
    await once(socket, 'connect')
    return socket
  }

  collect(socket) {
    const chunks = []
    socket.on('data', (chunk) => chunks.push(chunk))
    return once(socket, 'end').then(() => Buffer.concat(chunks))
  }

  async close() {
    for (const proxy of this.proxies) await proxy.end()
    for (const socket of this.sockets) socket.destroy()
    await new Promise((resolve) => this.server.close(resolve))
  }
}

async function check() {
  const fixture = new EchoCheck()
  const deadline = setTimeout(() => {
    console.error('Delayed proxy self-check timed out')
    process.exitCode = 1
    fixture.close()
  }, 10000)
  try {
    await fixture.start()
    const delayed = await fixture.proxy({ delayMillis: 25 })
    const split = await fixture.client(delayed.port)
    const splitReply = fixture.collect(split)
    const input = Buffer.from([208, 159, 209, 128, 240, 159, 153, 130, 0, 255, 128, 127])

    split.write(input.subarray(0, 1))
    split.write(input.subarray(1, 5))
    split.end(input.subarray(5))

    assert.deepStrictEqual(await splitReply, input)
    assert.strictEqual(delayed.failure, null)

    const burst = await fixture.client(delayed.port)
    const burstReply = fixture.collect(burst)
    const pieces = Array.from({ length: 20 }, () => Buffer.alloc(1024, 73))
    const started = performance.now()
    for (const piece of pieces) {
      burst.write(piece)
      await new Promise((resolve) => setTimeout(resolve, 2))
    }
    burst.end()
    assert.deepStrictEqual(await burstReply, Buffer.alloc(20480, 73))
    const roundTripMillis = performance.now() - started
    assert.ok(roundTripMillis >= 45, `Round-trip delay missing: ${roundTripMillis}ms`)
    assert.ok(roundTripMillis < 500, `Chunks appear to accumulate serial delays: ${roundTripMillis}ms`)
    assert.strictEqual(delayed.failure, null)

    const bounded = await fixture.proxy({ delayMillis: 1, highWaterMark: 8192 })
    const large = await fixture.client(bounded.port)
    const largeReply = fixture.collect(large)
    large.pause()
    const resume = setTimeout(() => large.resume(), 50)
    const payload = Buffer.allocUnsafe(4 * 1024 * 1024 + 17)
    for (let i = 0; i < payload.length; i++) payload[i] = i % 251
    if (!large.write(payload)) await once(large, 'drain')
    large.end()

    assert.deepStrictEqual(await largeReply, payload)
    clearTimeout(resume)
    assert.strictEqual(bounded.failure, null)

    const pending = await fixture.proxy({ delayMillis: 1000 })
    const pendingClient = await fixture.client(pending.port)
    const pendingClosed = once(pendingClient, 'close')
    pendingClient.write('pending delayed bytes')
    await new Promise((resolve) => setTimeout(resolve, 5))
    const ending = pending.end()
    assert.strictEqual(pending.end(), ending)
    await ending
    await pendingClosed

    const idle = await fixture.proxy({ delayMillis: 25 })
    const idleClient = await fixture.client(idle.port)
    const idleClosed = once(idleClient, 'close')
    await idle.end()
    await idleClosed

    console.log(
      `delay-check passed: split bytes, half-close, 4 MiB backpressure, ${roundTripMillis.toFixed(
        1
      )}ms burst RTT, teardown`
    )
  } finally {
    clearTimeout(deadline)
    await fixture.close()
  }
}

check().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
