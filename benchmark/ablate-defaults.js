'use strict'

// Diagnostic, version-locked source transforms: every changed arm gets its own commit and tree fingerprint.
const assert = require('assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')
const { createRequire } = require('module')

const BASELINE = 'b239cb414df2c916ab243a0943d410b61e7a83ae'
const INTERNAL = ['pg', 'pg-protocol', 'pg-pool', 'pg-connection-string']
const SQL = 'packages/pg/src/sql.ts'
const OLD_METADATA = `        const rows = result.rows as SqlRows<R>
        Object.defineProperty(rows, 'count', { value: result.rowCount })
        Object.defineProperty(rows, 'command', { value: result.command })
        Object.defineProperty(rows, 'columns', { value: result.fields })
        return rows`
const NEW_METADATA_BODY = `    const rows = result.rows as SqlResultRows<R>
    Object.setPrototypeOf(rows, SqlResultRows.prototype)
    Object.defineProperty(rows, rowsMetadata, {
      value: { count: result.rowCount, command: result.command, columns: result.fields },
    })
    return rows`

class AblationRun {
  constructor() {
    this.repo = path.resolve(__dirname, '..')
    this.output = path.join(this.repo, 'results', 'ablation')
    this.head = this.git(this.repo, ['rev-parse', 'HEAD']).trim()
    this.trial = Number(process.env.TRIAL || 1)
    assert.ok([1, 2, 3].includes(this.trial), 'TRIAL must be 1, 2 or 3')
    this.temp = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'pg-default-ablation-'))
    this.variants = []
  }

  git(cwd, args) {
    return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  }

  replaceOnce({ source, anchor, replacement }) {
    const start = source.indexOf(anchor)
    assert.ok(start !== -1 && source.indexOf(anchor, start + anchor.length) === -1, 'source anchor must occur once')
    return source.slice(0, start) + replacement + source.slice(start + anchor.length)
  }

  readAt({ commit, file }) {
    return this.git(this.repo, ['show', `${commit}:${file}`])
  }

  linkDependencies(dir) {
    const target = path.join(dir, 'node_modules')
    fs.mkdirSync(target)
    for (const entry of fs.readdirSync(path.join(this.repo, 'node_modules'))) {
      if (INTERNAL.includes(entry)) continue
      fs.symlinkSync(fs.realpathSync(path.join(this.repo, 'node_modules', entry)), path.join(target, entry))
    }
    for (const name of INTERNAL) fs.symlinkSync(path.join(dir, 'packages', name), path.join(target, name))
  }

  verifyDependencies(dir) {
    const driverRequire = createRequire(path.join(dir, 'packages/pg/package.json'))
    for (const name of INTERNAL) {
      assert.equal(
        fs.realpathSync(driverRequire.resolve(name)),
        fs.realpathSync(require.resolve(path.join(dir, 'packages', name))),
        `${name} must resolve in ${dir}`
      )
    }
  }

  prepare() {
    fs.mkdirSync(this.output, { recursive: true })
    const candidateSql = this.readAt({ commit: this.head, file: SQL })
    const baselineSql = this.readAt({ commit: BASELINE, file: SQL })
    const metadataStart = candidateSql.indexOf("const rowsMetadata = Symbol('rowsMetadata')")
    const metadataEnd = candidateSql.indexOf('export interface TransactionSql', metadataStart)
    assert.ok(metadataStart !== -1 && metadataEnd > metadataStart, 'candidate metadata class must exist')
    const metadataClass = candidateSql.slice(metadataStart, metadataEnd)
    const promiseSql = this.replaceOnce({
      source: this.replaceOnce({
        source: baselineSql,
        anchor: 'export interface TransactionSql',
        replacement: metadataClass + 'export interface TransactionSql',
      }),
      anchor: OLD_METADATA,
      replacement: '        return SqlResultRows.fromResult<R>(result)',
    })
    const variants = [
      { name: 'previous', parent: BASELINE, files: {} },
      { name: 'candidate', parent: this.head, files: {} },
      {
        name: 'metadata-old',
        parent: this.head,
        files: {
          [SQL]: this.replaceOnce({
            source: candidateSql,
            anchor: NEW_METADATA_BODY,
            replacement: OLD_METADATA.split('\n')
              .map((line) => line.slice(4))
              .join('\n'),
          }),
        },
      },
      {
        name: 'promise-old',
        parent: this.head,
        files: {
          [SQL]: promiseSql,
          'packages/pg/src/query-executor.ts': this.readAt({
            commit: BASELINE,
            file: 'packages/pg/src/query-executor.ts',
          }),
        },
      },
      {
        name: 'writes-old',
        parent: this.head,
        files: {
          'packages/pg/src/connection.ts': this.readAt({ commit: BASELINE, file: 'packages/pg/src/connection.ts' }),
        },
      },
      {
        name: 'rows-old',
        parent: this.head,
        files: { 'packages/pg/src/result.ts': this.readAt({ commit: BASELINE, file: 'packages/pg/src/result.ts' }) },
      },
    ]
    for (const { name, parent, files } of variants) {
      const dir = path.join(this.temp, name)
      this.git(this.repo, ['worktree', 'add', '--detach', dir, parent])
      this.linkDependencies(dir)
      const changed = Object.keys(files)
      for (const [file, source] of Object.entries(files)) fs.writeFileSync(path.join(dir, file), source)
      if (changed.length) {
        this.git(dir, ['add', '--', ...changed])
        this.git(dir, [
          '-c',
          'user.name=aicopilot-fr',
          '-c',
          'user.email=aicopilot_fr_mob@proton.me',
          'commit',
          '--no-gpg-sign',
          '-m',
          `benchmark: isolate ${name} [skip ci]`,
        ])
      }
      const commit = this.git(dir, ['rev-parse', 'HEAD']).trim()
      const tree = this.git(dir, ['rev-parse', 'HEAD^{tree}']).trim()
      const patch = this.git(dir, ['diff', '--binary', parent, 'HEAD'])
      fs.writeFileSync(path.join(this.output, `${name}.patch`), patch)
      this.variants.push({ name, dir, parent, commit, tree, changed, patch: `${name}.patch` })
      this.saveManifest()
      execFileSync(process.execPath, [path.join(this.repo, 'node_modules/typescript/bin/tsc'), '--build'], {
        cwd: dir,
        stdio: 'inherit',
      })
      this.verifyDependencies(dir)
      assert.equal(
        this.git(dir, ['status', '--porcelain', '--untracked-files=no']).trim(),
        '',
        'measured source must be clean'
      )
      console.log(`Prepared ${name}: ${commit} tree ${tree}`)
    }
  }

  saveManifest() {
    fs.writeFileSync(
      path.join(this.output, 'variants.json'),
      JSON.stringify(
        { baseline: BASELINE, candidate: this.head, trial: this.trial, temp: this.temp, variants: this.variants },
        null,
        2
      ) + '\n'
    )
  }

  compare({ variant, scenario, label }) {
    const previous = this.variants.find(({ name }) => name === 'previous')
    execFileSync(
      process.execPath,
      [
        path.join(this.repo, 'benchmark/compare.js'),
        '--profile',
        'sql-compile',
        '--base',
        previous.dir,
        '--head',
        variant.dir,
        '--scenario',
        scenario,
        '--rounds',
        '8',
        '--duration',
        '2',
        '--warmup',
        '1',
        '--output',
        path.join(this.output, `${label}.md`),
        '--json-output',
        path.join(this.output, `${label}.json`),
      ],
      { cwd: this.repo, stdio: 'inherit' }
    )
  }

  run() {
    this.prepare()
    if (process.argv.includes('--prepare-only')) return
    const arms = this.variants.filter(({ name }) => name !== 'previous')
    const offset = (this.trial - 1) * 2
    const order = arms.map((_, index) => arms[(index + offset) % arms.length])
    for (const variant of order) {
      this.compare({ variant, scenario: 'tagged point SELECT, concurrent x16', label: `point-${variant.name}` })
    }
    this.compare({
      variant: this.variants.find(({ name }) => name === 'candidate'),
      scenario: 'tagged 500-row mixed SELECT, concurrent x16',
      label: 'mixed-candidate',
    })
  }
}

assert.ok(
  process.argv.slice(2).every((arg) => arg === '--prepare-only'),
  'only --prepare-only is supported'
)
new AblationRun().run()
