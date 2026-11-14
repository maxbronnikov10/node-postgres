'use strict'

const net = require('net')
const { performance } = require('perf_hooks')

class DelayedDirection {
  constructor({ source, destination, delayMillis, highWaterMark }) {
    this.source = source
    this.destination = destination
    this.delayMillis = delayMillis
    this.highWaterMark = highWaterMark
    this.queue = []
    this.queuedBytes = 0
    this.timer = null
    this.blocked = false
    this.sourceEnded = false
    this.stopped = false
    this.finished = false
    this.onData = (data) => {
      this.queue.push({ data, due: performance.now() + this.delayMillis })
      this.queuedBytes += data.length
      this.updateFlow()
      this.pump()
    }
    this.onEnd = () => {
      this.sourceEnded = true
      this.pump()
    }
    this.onDrain = () => {
      this.blocked = false
      this.pump()
    }
    source.on('data', this.onData)
    source.on('end', this.onEnd)
    destination.on('drain', this.onDrain)
  }

  updateFlow() {
    if (this.blocked || this.queuedBytes >= this.highWaterMark) this.source.pause()
    else if (!this.sourceEnded && !this.stopped) this.source.resume()
  }

  pump() {
    if (this.stopped || this.blocked || this.timer !== null) return
    while (this.queue.length) {
      const wait = this.queue[0].due - performance.now()
      if (wait > 0) {
        this.timer = setTimeout(() => {
          this.timer = null
          this.pump()
        }, wait)
        break
      }
      const { data } = this.queue.shift()
      this.queuedBytes -= data.length
      if (!this.destination.write(data)) {
        this.blocked = true
        break
      }
    }
    this.updateFlow()
    if (this.sourceEnded && !this.queue.length && !this.blocked && !this.finished) {
      this.finished = true
      this.destination.end()
    }
  }

  stop() {
    this.stopped = true
    clearTimeout(this.timer)
    this.timer = null
    this.queue.length = 0
    this.queuedBytes = 0
    this.source.removeListener('data', this.onData)
    this.source.removeListener('end', this.onEnd)
    this.destination.removeListener('drain', this.onDrain)
  }
}

class DelayedProxy {
  constructor({ host, port, delayMillis, highWaterMark = 262144 }) {
    if (typeof host !== 'string' || !host || !Number.isInteger(port) || port < 1 || port > 65535) {
      throw new TypeError('DelayedProxy requires a host and TCP port')
    }
    if (!Number.isFinite(delayMillis) || delayMillis < 0 || delayMillis > 2147483647) {
      throw new RangeError('delayMillis must fit a nonnegative Node timer')
    }
    if (!Number.isSafeInteger(highWaterMark) || highWaterMark <= 0) {
      throw new RangeError('highWaterMark must be a positive safe integer')
    }
    this.target = { host, port, allowHalfOpen: true }
    this.delayMillis = delayMillis
    this.highWaterMark = highWaterMark
    this.failure = null
    this.connections = new Set()
    this.ending = null
    this.server = net.createServer({ allowHalfOpen: true }, (frontend) => this.connect(frontend))
    this.server.on('error', (error) => {
      if (!this.ending) this.failure ??= error
    })
  }

  async start() {
    if (this.ending) throw new Error('DelayedProxy has ended')
    await new Promise((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(0, '127.0.0.1', () => {
        this.server.removeListener('error', reject)
        resolve()
      })
    })
    this.port = this.server.address().port
    return this
  }

  connect(frontend) {
    if (this.ending) return frontend.destroy()
    const upstream = net.createConnection(this.target)
    frontend.setNoDelay(true)
    upstream.setNoDelay(true)
    const forward = new DelayedDirection({
      source: frontend,
      destination: upstream,
      delayMillis: this.delayMillis,
      highWaterMark: this.highWaterMark,
    })
    const backward = new DelayedDirection({
      source: upstream,
      destination: frontend,
      delayMillis: this.delayMillis,
      highWaterMark: this.highWaterMark,
    })
    const record = { frontend, upstream, forward, backward }
    this.connections.add(record)
    const fail = (error) => {
      if (!this.ending) this.failure ??= error
      forward.stop()
      backward.stop()
      frontend.destroy()
      upstream.destroy()
    }
    frontend.on('error', fail)
    upstream.on('error', fail)
    const closed = (source) => {
      if (!source.readableEnded && !this.ending) fail(new Error('DelayedProxy transport closed before EOF'))
      if (frontend.destroyed && upstream.destroyed) this.connections.delete(record)
    }
    frontend.on('close', () => closed(frontend))
    upstream.on('close', () => closed(upstream))
  }

  end() {
    if (this.ending) return this.ending
    this.ending = new Promise((resolve, reject) => {
      for (const { frontend, upstream, forward, backward } of this.connections) {
        forward.stop()
        backward.stop()
        frontend.destroy()
        upstream.destroy()
      }
      this.connections.clear()
      if (!this.server.listening) return resolve()
      this.server.close((error) => (error ? reject(error) : resolve()))
    })
    return this.ending
  }
}

module.exports = { DelayedProxy }
