const assert = require('node:assert/strict')
const pg = require('../../packages/pg')
for (const name of ['PGHOST', 'PGPORT', 'PGUSER', 'PGDATABASE']) assert.ok(process.env[name], `Set ${name} explicitly`)
assert.match(process.env.PGDATABASE, /^(nodepg_|benchmark)/, 'Requires a disposable database')
const port = Number(process.env.PGPORT)
assert.ok(Number.isInteger(port) && port > 0 && port <= 65535)
const applicationName = `nodepg_adaptive_lock_check_${process.pid}`
const options = {
  host: process.env.PGHOST,
  port,
  user: process.env.PGUSER,
  database: process.env.PGDATABASE,
  max: 4,
  application_name: applicationName,
  query_timeout: 10000,
}
const sql = pg.postgres(options)
const control = new pg.Client(options)
const pause = () => new Promise((resolve) => setTimeout(resolve, 10))
const query = () => sql`SELECT pg_backend_pid() AS pid`.execute()
;(async () => {
  await control.connect()
  let blocked = []
  try {
    const warm = await Promise.all(
      Array.from({ length: 65 }, () => sql`SELECT pg_backend_pid() AS pid, pg_sleep(0.005)`)
    )
    assert.equal(new Set(warm.map(([row]) => row.pid)).size, 4)
    let preferred = []
    for (let attempt = 0; attempt < 100; attempt++) {
      const rows = await Promise.all(Array.from({ length: 16 }, query))
      preferred = [...new Set(rows.map(([row]) => row.pid))]
      if (preferred.length === 2) break
      await pause()
    }
    assert.equal(preferred.length, 2, 'short reads must demonstrate the learned pair before testing exclusion')
    await control.query('BEGIN')
    await control.query('SELECT pg_advisory_xact_lock(984735624)')
    blocked = Array.from({ length: 2 }, () => sql`SELECT pg_advisory_xact_lock(${984735624})`.execute())
    let waiting = []
    for (let attempt = 0; attempt < 300; attempt++) {
      waiting = (
        await control.query(
          "SELECT pid FROM pg_stat_activity WHERE application_name = $1 AND wait_event = 'advisory'",
          [applicationName]
        )
      ).rows.map((row) => row.pid)
      if (waiting.length === 2) break
      await pause()
    }
    assert.equal(waiting.length, 2)
    assert.deepEqual([...waiting].sort(), [...preferred].sort(), 'both preferred backends must be blocked')
    let timer
    try {
      const rows = await Promise.race([
        Promise.all(Array.from({ length: 16 }, query)),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('short reads were blocked behind ordinary queries')), 2000)
        }),
      ])
      const routed = [...new Set(rows.map(([row]) => row.pid))]
      assert.equal(routed.length, 2)
      assert.ok(routed.every((pid) => !waiting.includes(pid)))
      console.log(
        JSON.stringify({
          passed: true,
          warmBackends: 4,
          preferredBackends: 2,
          blockedOrdinaryBackends: 2,
          readsCompletedBeforeUnlock: 16,
          fallbackBackends: routed.length,
        })
      )
    } finally {
      clearTimeout(timer)
    }
  } finally {
    await control.query('ROLLBACK')
    await Promise.allSettled(blocked)
    await sql.end()
    await control.end()
  }
})().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
