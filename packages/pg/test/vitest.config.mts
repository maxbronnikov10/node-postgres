import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config'

export default defineWorkersConfig({
  test: {
    watch: false,
    env: Object.fromEntries(
      Object.entries(process.env).filter(([name]) => /^PG(HOST|PORT|USER|PASSWORD|DATABASE)$/.test(name))
    ),
    poolOptions: {
      workers: {
        wrangler: { configPath: './wrangler.jsonc' },
      },
    },
  },
})
