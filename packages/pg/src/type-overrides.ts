import type { BinaryParser, CustomTypesConfig, TextParser, TypeFormat } from './types'

const types = require('pg-types') as unknown as CustomTypesConfig
type Parser = TextParser | BinaryParser
type Overrides = Record<number, Parser | undefined>

class TypeOverrides implements CustomTypesConfig {
  private readonly _types: CustomTypesConfig
  readonly text: Overrides
  readonly binary: Overrides

  constructor(userTypes?: CustomTypesConfig) {
    this._types = userTypes || types
    this.text = {}
    this.binary = {}
  }

  getOverrides(format?: string): Overrides {
    switch (format) {
      case 'text':
        return this.text
      case 'binary':
        return this.binary
      default:
        return {}
    }
  }

  setTypeParser(oid: number, parseFn: TextParser): void
  setTypeParser(oid: number, format: 'text', parseFn: TextParser): void
  setTypeParser(oid: number, format: 'binary', parseFn: BinaryParser): void
  setTypeParser(oid: number, format: TypeFormat | Parser, parseFn?: Parser): void
  setTypeParser(oid: number, format: TypeFormat | Parser, parseFn?: Parser): void {
    if (typeof format === 'function') {
      parseFn = format
      format = 'text'
    }
    this.getOverrides(format)[oid] = parseFn
  }

  getTypeParser(oid: number, format?: 'text'): TextParser
  getTypeParser(oid: number, format: 'binary'): BinaryParser
  getTypeParser(oid: number, format?: TypeFormat): Parser
  getTypeParser(oid: number, format?: TypeFormat): Parser {
    format = format || 'text'
    return this.getOverrides(format)[oid] || this._types.getTypeParser(oid, format)
  }
}

export = TypeOverrides
