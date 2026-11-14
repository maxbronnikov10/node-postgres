'use strict'

const assert = require('assert/strict')

class RowWorkload {
  constructor({ pg, profile, arm }) {
    assert.ok(['rows', 'row-formats'].includes(profile))
    assert.ok(Number.isInteger(arm) && arm >= 0 && arm < 4)
    this.pg = pg
    this.binary = profile === 'row-formats' && arm % 2 === 1
    this.clients = []
    this.all = {}
    const bytes = Buffer.from('00ff807f'.repeat(4096), 'hex')
    if (profile === 'rows') {
      for (const rowMode of ['object', 'array']) {
        this.addCase({
          name: `text scalar ${rowMode}, 128 rows`,
          text: "SELECT 17::int4 AS n, 'Привет🙂'::text AS s, ''::text AS empty, NULL::text AS missing FROM generate_series(1, 128)",
          expected: { n: 17, s: 'Привет🙂', empty: '', missing: null },
          count: 128,
          rowMode,
        })
      }
      const wide = Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`c${i}`, 'Привет🙂']))
      this.addCase({
        name: 'text wide object, 128 rows x16 fields',
        text: `SELECT ${Object.keys(wide)
          .map((name) => `'Привет🙂'::text AS ${name}`)
          .join(', ')} FROM generate_series(1, 128)`,
        expected: wide,
        count: 128,
      })
    } else {
      this.addCase({
        name: 'text vs binary scalar object, 128 rows',
        text: 'SELECT -16909061::int4 AS n, 1.5::float8 AS f, true AS ok FROM generate_series(1, 128)',
        expected: { n: -16909061, f: 1.5, ok: true },
        count: 128,
      })
    }
    this.addCase({
      name: `${profile === 'rows' ? 'text' : 'text vs binary'} bytea object, 16 rows x16 KiB`,
      text: "SELECT decode(repeat('00ff807f', 4096), 'hex') AS value FROM generate_series(1, 16)",
      expected: { value: bytes },
      count: 16,
    })
  }

  addCase({ name, text, expected, count, rowMode = 'object' }) {
    const client = new this.pg.Client({
      types: {
        // pg-types has no built-in binary bytea codec; the fixture supplies that codec on both arms.
        getTypeParser: (oid, format) =>
          oid === 17 && format === 'binary' ? (value) => value : this.pg.types.getTypeParser(oid, format),
      },
    })
    this.clients.push(client)
    const entries = Object.entries(expected)
    const config = { text, name: `benchmark_rows_${this.clients.length}`, binary: this.binary, rowMode }
    const run = async () => {
      const result = await client.query(config)
      assert.equal(result.rowCount, count)
      assert.equal(result.rows.length, count)
      for (const row of result.rows) {
        for (let i = 0; i < entries.length; i++) {
          const [name, value] = entries[i]
          const actual = row[rowMode === 'array' ? i : name]
          if (Buffer.isBuffer(value)) {
            assert.ok(Buffer.isBuffer(actual))
            assert.ok(actual.equals(value))
          } else {
            assert.equal(actual, value)
          }
        }
      }
      return 1
    }
    run.prepare = async () => {
      await run()
      assert.equal(client.getTransactionStatus(), 'I')
    }
    this.all[name] = run
  }
}

const createRowWorkload = async ({ pg, profile, arm }) => {
  const workload = new RowWorkload({ pg, profile, arm })
  await Promise.all(workload.clients.map((client) => client.connect()))
  return { all: workload.all, clients: workload.clients, pools: [] }
}

module.exports = { createRowWorkload }
