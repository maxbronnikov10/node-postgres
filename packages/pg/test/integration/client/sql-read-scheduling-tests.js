'use strict'

const assert = require('assert')
const helper = require('./test-helper')
if (helper.args.native || typeof require('events').addAbortListener !== 'function') return
const suite = new helper.Suite('SQL read scheduling')

suite.test('single-row UPDATE results keep all four backends and persist each write once', async () => {
  const sql = helper.pg({ ...helper.config, max: 4 })
  const control = new helper.pg.Client()
  const table = `sql_read_scheduling_${process.pid}`
  await control.connect()
  try {
    await control.query(`CREATE TABLE ${table} (id integer PRIMARY KEY, count integer NOT NULL)`)
    await control.query(`INSERT INTO ${table} SELECT id, 0 FROM generate_series(1, 16) id`)
    await Promise.all(Array.from({ length: 65 }, () => sql`SELECT pg_sleep(0.005)`.execute()))
    const update = (id) =>
      sql`UPDATE ${sql.identifier(
        table
      )} SET count = count + 1 WHERE id = ${id} RETURNING pg_backend_pid() AS pid`.execute()

    const first = await Promise.all(Array.from({ length: 16 }, (_, index) => update(index + 1)))
    const second = await Promise.all(Array.from({ length: 16 }, (_, index) => update(index + 1)))

    assert.strictEqual(new Set(first.map((result) => result[0].pid)).size, 4)
    assert.strictEqual(new Set(second.map((result) => result[0].pid)).size, 4)
    assert.deepStrictEqual((await control.query(`SELECT sum(count)::int AS count FROM ${table}`)).rows, [{ count: 32 }])
  } finally {
    await sql.end()
    await control.query(`DROP TABLE IF EXISTS ${table}`)
    await control.end()
  }
})
