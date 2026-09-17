const EventEmitter = require('events')
const Pool = require('../')

const expect = require('expect.js')

describe('releasing clients', () => {
  it('hands a released client to pending requests in FIFO order', async () => {
    let unrefs = 0
    class FakeClient extends EventEmitter {
      connect(callback) {
        this._queryable = true
        callback()
      }
      end(callback) {
        callback && callback()
      }
      ref() {}
      unref() {
        unrefs++
      }
    }
    const pool = new Pool({ Client: FakeClient, allowExitOnIdle: true, max: 1 })
    const events = []
    pool.on('acquire', () => events.push('acquire'))
    pool.on('release', () => events.push('release'))
    const client = await pool.connect()
    const first = pool.connect()
    const second = pool.connect()
    expect(pool.waitingCount).to.equal(2)

    client.release()
    const next = await first
    expect(next).to.equal(client)
    expect(pool.waitingCount).to.equal(1)
    expect(pool.idleCount).to.equal(0)
    next.release()
    const last = await second
    expect(last).to.equal(client)
    expect(pool.waitingCount).to.equal(0)
    expect(pool.idleCount).to.equal(0)
    expect(unrefs).to.equal(0)
    expect(events).to.eql(['acquire', 'release', 'acquire', 'release', 'acquire'])

    last.release()
    await pool.end()
  })

  it('removes a client which cannot be queried', async () => {
    // make a pool w/ only 1 client
    const pool = new Pool({ max: 1 })
    expect(pool.totalCount).to.eql(0)
    const client = await pool.connect()
    expect(pool.totalCount).to.eql(1)
    expect(pool.idleCount).to.eql(0)
    // reach into the client and sever its connection
    client.connection.end()

    // wait for the client to error out
    const err = await new Promise((resolve) => client.once('error', resolve))
    expect(err).to.be.ok()
    expect(pool.totalCount).to.eql(1)
    expect(pool.idleCount).to.eql(0)

    // try to return it to the pool - this removes it because its broken
    client.release()
    expect(pool.totalCount).to.eql(0)
    expect(pool.idleCount).to.eql(0)

    // make sure pool still works
    const { rows } = await pool.query('SELECT NOW()')
    expect(rows).to.have.length(1)
    await pool.end()
  })

  it('removes a client which is ending', async () => {
    // make a pool w/ only 1 client
    const pool = new Pool({ max: 1 })
    expect(pool.totalCount).to.eql(0)
    const client = await pool.connect()
    expect(pool.totalCount).to.eql(1)
    expect(pool.idleCount).to.eql(0)
    // end the client gracefully (but you shouldn't do this with pooled clients)
    client.end()

    // try to return it to the pool
    client.release()
    expect(pool.totalCount).to.eql(0)
    expect(pool.idleCount).to.eql(0)

    // make sure pool still works
    const { rows } = await pool.query('SELECT NOW()')
    expect(rows).to.have.length(1)
    await pool.end()
  })
})
