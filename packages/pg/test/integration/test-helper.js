'use strict'
const helper = require('./../test-helper')
const { Client } = helper
const assert = require('assert')

// creates a client from cli parameters
helper.client = function (cb, options) {
  const client = new Client(options)
  client.connect(cb)
  return client
}

helper.versionGTE = function (client, testVersion, callback) {
  client.query(
    'SHOW server_version_num',
    assert.calls(function (err, result) {
      if (err) return callback(err)
      const version = parseInt(result.rows[0].server_version_num, 10)
      return callback(null, version >= testVersion)
    })
  )
}

// export parent helper stuffs
module.exports = helper
