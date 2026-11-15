'use strict'

import dns = require('dns')

import defaults = require('./defaults')
import type { ClientConfig, Password, SslOptions } from './types'
type ParsedConfig = ClientConfig & Record<string, unknown>

const parse = require('pg-connection-string').parse as (connectionString: string) => ParsedConfig // parses a connection string

const val = function (key: string, config: ClientConfig, envVar?: string | false): unknown {
  if ((config as unknown as Record<string, unknown>)[key]) {
    return (config as unknown as Record<string, unknown>)[key]
  }

  if (envVar === undefined) {
    envVar = process.env['PG' + key.toUpperCase()]
  } else if (envVar === false) {
    // do nothing ... use false
  } else {
    envVar = process.env[envVar]
  }

  return envVar || (defaults as unknown as Record<string, unknown>)[key]
}

const readSSLConfigFromEnvironment = function () {
  switch (process.env.PGSSLMODE) {
    case 'disable':
      return false
    case 'prefer':
    case 'require':
    case 'verify-ca':
    case 'verify-full':
      return true
    case 'no-verify':
      return { rejectUnauthorized: false }
  }
  return defaults.ssl
}

// Convert arg to a string, surround in single quotes, and escape single quotes and backslashes
const quoteParamValue = function (value: unknown) {
  return "'" + ('' + value).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'"
}

const add = function (params: string[], config: object, paramName: string) {
  const value = (config as Record<string, unknown>)[paramName]
  if (value !== undefined && value !== null) {
    params.push(paramName + '=' + quoteParamValue(value))
  }
}

class ConnectionParameters {
  user: string
  database: string
  declare password: Password
  port: number
  host: string
  binary: boolean | undefined
  options: string | undefined
  ssl: ClientConfig['ssl']
  sslnegotiation: 'postgres' | 'direct' | undefined
  client_encoding: string | undefined
  replication: string | boolean | undefined
  isDomainSocket: boolean
  application_name: string | undefined
  fallback_application_name: string | undefined
  statement_timeout: number | false | undefined
  lock_timeout: number | false | undefined
  idle_in_transaction_session_timeout: number | false | undefined
  query_timeout: number | false | undefined
  connect_timeout: number | string
  keepalives: number | undefined
  keepalives_idle: number | undefined
  nativeConnectionString?: string

  constructor(config?: string | ClientConfig) {
    // if a string is passed, it is a raw connection string so we parse it into a config
    config = typeof config === 'string' ? parse(config) : config || {}

    // if the config has a connectionString defined, parse IT into the config we use
    // this will override other default values with what is stored in connectionString
    if (config.connectionString) {
      config = Object.assign({}, config, parse(config.connectionString))
    }

    this.user = val('user', config) as string
    this.database = val('database', config) as string

    if (this.database === undefined) {
      this.database = this.user
    }

    this.port = parseInt(val('port', config) as string, 10)
    this.host = val('host', config) as string

    // "hiding" the password so it doesn't show up in stack traces
    // or if the client is console.logged
    Object.defineProperty(this, 'password', {
      configurable: true,
      enumerable: false,
      writable: true,
      value: val('password', config),
    })

    this.binary = val('binary', config) as boolean | undefined
    this.options = val('options', config) as string | undefined

    this.ssl = typeof config.ssl === 'undefined' ? readSSLConfigFromEnvironment() : config.ssl

    if (typeof this.ssl === 'string') {
      if (this.ssl === 'true') {
        this.ssl = true
      }
    }
    // support passing in ssl=no-verify via connection string
    if ((this.ssl as unknown) === 'no-verify') {
      this.ssl = { rejectUnauthorized: false }
    }
    if (this.ssl && (this.ssl as SslOptions).key) {
      Object.defineProperty(this.ssl, 'key', {
        enumerable: false,
      })
    }

    // How to negotiate SSL: 'postgres' (default, the traditional SSLRequest
    // handshake) or 'direct' (start the TLS handshake immediately on connect).
    this.sslnegotiation = val('sslnegotiation', config, 'PGSSLNEGOTIATION') as 'postgres' | 'direct' | undefined
    if (this.sslnegotiation !== undefined && this.sslnegotiation !== 'postgres' && this.sslnegotiation !== 'direct') {
      throw new Error(
        `Invalid sslnegotiation value: "${this.sslnegotiation}". Valid values are "postgres" and "direct".`
      )
    }
    if (this.sslnegotiation === 'direct' && !this.ssl) {
      throw new Error('sslnegotiation=direct requires SSL to be enabled')
    }

    this.client_encoding = val('client_encoding', config) as string | undefined
    this.replication = val('replication', config) as string | boolean | undefined
    // a domain socket begins with '/'
    this.isDomainSocket = !(this.host || '').indexOf('/')

    this.application_name = val('application_name', config, 'PGAPPNAME') as string | undefined
    this.fallback_application_name = val('fallback_application_name', config, false) as string | undefined
    this.statement_timeout = val('statement_timeout', config, false) as number | false | undefined
    this.lock_timeout = val('lock_timeout', config, false) as number | false | undefined
    this.idle_in_transaction_session_timeout = val('idle_in_transaction_session_timeout', config, false) as
      | number
      | false
      | undefined
    this.query_timeout = val('query_timeout', config, false) as number | false | undefined

    if (config.connectionTimeoutMillis === undefined) {
      this.connect_timeout = process.env.PGCONNECT_TIMEOUT || 0
    } else {
      this.connect_timeout = Math.floor(config.connectionTimeoutMillis / 1000)
    }

    if (config.keepAlive === false) {
      this.keepalives = 0
    } else if (config.keepAlive === true) {
      this.keepalives = 1
    }

    if (typeof config.keepAliveInitialDelayMillis === 'number') {
      this.keepalives_idle = Math.floor(config.keepAliveInitialDelayMillis / 1000)
    }
  }

  getLibpqConnectionString(cb: (error: NodeJS.ErrnoException | null, connectionString: string | null) => void) {
    const params: string[] = []
    add(params, this, 'user')
    add(params, this, 'password')
    add(params, this, 'port')
    add(params, this, 'application_name')
    add(params, this, 'fallback_application_name')
    add(params, this, 'connect_timeout')
    add(params, this, 'options')

    const ssl = typeof this.ssl === 'object' ? this.ssl : this.ssl ? { sslmode: this.ssl } : {}
    add(params, ssl, 'sslmode')
    add(params, ssl, 'sslca')
    add(params, ssl, 'sslkey')
    add(params, ssl, 'sslcert')
    add(params, ssl, 'sslrootcert')
    add(params, this, 'sslnegotiation')

    if (this.database) {
      params.push('dbname=' + quoteParamValue(this.database))
    }
    if (this.replication) {
      params.push('replication=' + quoteParamValue(this.replication))
    }
    if (this.host) {
      params.push('host=' + quoteParamValue(this.host))
    }
    if (this.isDomainSocket) {
      return cb(null, params.join(' '))
    }
    if (this.client_encoding) {
      params.push('client_encoding=' + quoteParamValue(this.client_encoding))
    }
    dns.lookup(this.host, function (err, address) {
      if (err) return cb(err, null)
      params.push('hostaddr=' + quoteParamValue(address))
      return cb(null, params.join(' '))
    })
  }
}

export = ConnectionParameters
