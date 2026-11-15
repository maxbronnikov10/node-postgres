import type Result = require('./result')

export const submitQuery = Symbol('submitQuery')

export interface SqlQueryConfig {
  text: string
  values: readonly unknown[]
  rowMode: 'object' | 'array'
  queryMode: 'extended'
}

export interface QuerySubmission {
  config: SqlQueryConfig
  resolve: (result: Result) => void
  reject: (reason: unknown) => void
}
