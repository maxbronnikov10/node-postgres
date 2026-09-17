'use strict'

const assert = require('assert')
const Batch = require('../../../lib/batch')
const helper = require('./test-helper')

const suite = new helper.Suite()
const test = suite.test.bind(suite)

test('batch named statement validation resolves names lazily and preserves precedence', function () {
  const parsed = Object.create(null)
  parsed.target = 'select parsed'
  const submitted = Object.create(null)
  submitted.target = 'select submitted'
  const noEnumeration = {
    ownKeys() {
      throw new Error('named statement registries must not be copied')
    },
  }
  const connection = {
    parsedStatements: new Proxy(parsed, noEnumeration),
    submittedNamedStatements: new Proxy(submitted, noEnumeration),
  }

  const externalConflict = new Batch([{ name: 'target', text: 'select parsed' }])
  const error = externalConflict.submit(connection)
  assert.equal(error.message, "Prepared statements must be unique - 'target' was used for a different statement")
  assert.equal(parsed.target, 'select parsed')
  assert.equal(submitted.target, 'select submitted')

  const withinBatchConflict = new Batch([
    { name: '__proto__', text: 'select 1' },
    { name: '__proto__', text: 'select 2' },
  ])
  const batchError = withinBatchConflict.submit({ parsedStatements: {}, submittedNamedStatements: {} })
  assert.equal(
    batchError.message,
    "Prepared statements must be unique - '__proto__' was used for a different statement"
  )

  const namedOnly = new Batch([{ name: 'target' }])
  namedOnly._write = () => {}
  assert.equal(
    namedOnly.submit({
      parsedStatements: connection.parsedStatements,
      submittedNamedStatements: connection.submittedNamedStatements,
      once() {},
    }),
    null
  )
})
