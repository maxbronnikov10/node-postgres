import type { IndependentQueryConfig, QueryResult } from './types'

export const submitQuery = Symbol('submitQuery')

export interface QuerySubmission {
  config: IndependentQueryConfig
  resolve: (result: QueryResult) => void
  reject: (reason: unknown) => void
}
