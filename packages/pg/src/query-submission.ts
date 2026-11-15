import type Result = require('./result')
import type { IndependentQueryConfig } from './types'

export const submitQuery = Symbol('submitQuery')

export interface QuerySubmission {
  input: string | IndependentQueryConfig
  values?: readonly unknown[]
  argumentCount: number
  resolve: (result: Result) => void
  reject: (reason: unknown) => void
}
