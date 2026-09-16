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
