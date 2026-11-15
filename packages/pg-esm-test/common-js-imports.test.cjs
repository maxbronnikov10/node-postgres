const assert = require('assert')
const test = require('node:test')
const { describe, it } = test

const paths = [
  'pg',
  'pg/lib/index.js',
  'pg/lib/index',
  'pg/lib/connection-parameters',
  'pg/lib/connection-parameters.js',
  'pg/lib/type-overrides',
  'pg-protocol/dist/messages.js',
  'pg-protocol/dist/messages',
]
for (const path of paths) {
  describe(`importing ${path}`, () => {
    it('works with require', () => {
      const mod = require(path)
      assert(mod)
    })
  })
}
