'use strict'

const net = require('net')

// Plain TCP only. This fixture never negotiates TLS or inspects frontend credentials.
class QueryExecutorFaultProxy {
  constructor({ host, port, mode = 'drop-ready', listenPort = 0 }) {
    this.target = { host, port }
    this.mode = mode
    this.listenPort = listenPort
    this.acceptedCount = 0
    this.sockets = new Set()
    this.dropped = false
    this.failure = null
    this.server = net.createServer({ allowHalfOpen: true }, (frontend) => this.relay(frontend))
  }

  async start() {
    await new Promise((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(this.listenPort, '127.0.0.1', () => {
        this.server.removeListener('error', reject)
        resolve()
      })
    })
    this.port = this.server.address().port
    return this
  }

  relay(frontend) {
    this.acceptedCount++
    this.sockets.add(frontend)
    if (this.mode === 'blackhole') {
      frontend.on('error', () => frontend.destroy())
      frontend.on('close', () => this.sockets.delete(frontend))
      frontend.resume()
      return
    }
    const upstream = net.createConnection(this.target)
    this.sockets.add(upstream)
    const close = () => {
      frontend.destroy()
      upstream.destroy()
    }
    frontend.on('error', close)
    upstream.on('error', close)
    frontend.on('close', () => {
      this.sockets.delete(frontend)
      upstream.destroy()
    })
    upstream.on('close', () => {
      this.sockets.delete(upstream)
      if (this.mode === 'hold-close') this.server.emit('withheldClose')
      else frontend.destroy()
    })
    frontend.pipe(upstream)
    if (this.mode === 'relay' || this.mode === 'hold-close') {
      upstream.pipe(frontend, { end: this.mode === 'relay' })
      return
    }
    const heldResult = []
    let heldBytes = 0
    let startupReady = false
    let pending = Buffer.alloc(0)
    const maxFrameLength = 1024 * 1024
    upstream.on('data', (chunk) => {
      if (pending.length + chunk.length > maxFrameLength * 2) {
        this.failure = new Error('Fault proxy backend buffer exceeded its fixture bound')
        return close()
      }
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk
      let offset = 0
      while (offset + 5 <= pending.length) {
        const length = pending.readUInt32BE(offset + 1)
        if (length < 4 || length > maxFrameLength) {
          this.failure = new Error('Fault proxy received an invalid or oversized backend frame')
          return close()
        }
        if (offset + 1 + length > pending.length) break
        const frame = pending.subarray(offset, offset + 1 + length)
        offset += 1 + length
        if (this.mode === 'gate-result' && startupReady && !this.dropped) {
          heldBytes += frame.length
          if (heldBytes > maxFrameLength * 2) {
            this.failure = new Error('Fault proxy held result exceeded its fixture bound')
            return close()
          }
          heldResult.push(Buffer.from(frame))
          if (frame[0] === 90) {
            this.dropped = true
            this._releaseResult = () => {
              frontend.write(Buffer.concat(heldResult))
              heldResult.length = 0
              heldBytes = 0
              this._releaseResult = null
            }
            this.server.emit('resultHeld')
          }
          continue
        }
        if (frame[0] === 90) {
          if (startupReady && !this.dropped) {
            this.dropped = true
            pending = Buffer.alloc(0)
            if (this.mode === 'hold-completion') return
            return close()
          }
          startupReady = true
        }
        if (!frontend.write(frame)) {
          upstream.pause()
          frontend.once('drain', () => upstream.resume())
        }
      }
      pending = pending.subarray(offset)
    })
    upstream.on('end', () => frontend.end())
  }

  releaseResult() {
    if (!this._releaseResult) throw new Error('No result is held')
    this._releaseResult()
  }

  async close() {
    for (const socket of this.sockets) socket.destroy()
    if (!this.server.listening) return
    await new Promise((resolve, reject) => this.server.close((error) => (error ? reject(error) : resolve())))
  }
}

module.exports = QueryExecutorFaultProxy
