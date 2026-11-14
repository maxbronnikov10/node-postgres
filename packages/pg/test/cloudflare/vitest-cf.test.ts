import { Pool } from 'pg'
import { test } from 'vitest'
import assert from 'assert'
import utils from '../../lib/utils'

test('query config normalization in a worker', () => {
  const config = { text: 'SELECT 1' }
  assert.strictEqual(utils.normalizeQueryConfig(config), config)
  const proxy = new Proxy(config, { get: () => 'intercepted' })
  assert.equal(utils.normalizeQueryConfig(proxy).text, 'SELECT 1')
})

test('default', async () => {
  const pool = new Pool()
  const result = await pool.query('SELECT $1::text as name', ['cloudflare'])
  assert(result.rows[0].name === 'cloudflare')
  pool.end()
})

test('a converter throwing null rejects in a worker and the pool recovers', async () => {
  const pool = new Pool({ max: 1 })
  try {
    await assert.rejects(
      pool.query('SELECT $1::text', [
        {
          toPostgres() {
            throw null
          },
        },
      ]),
      (error) => {
        assert(error instanceof Error)
        assert.strictEqual(error.cause, null)
        return true
      }
    )

    assert.strictEqual((await pool.query('SELECT 17 AS n')).rows[0].n, 17)
  } finally {
    await pool.end()
  }
})
