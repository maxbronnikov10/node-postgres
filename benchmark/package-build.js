'use strict'

const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const { createHash } = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const root = process.cwd()
const names = ['pg', 'pg-protocol', 'pg-pool', 'pg-connection-string']

class PackageBuilder {
  run({ command, args, cwd = root }) {
    return execFileSync(command, args, { cwd, encoding: 'utf8', timeout: 120000, maxBuffer: 8 * 1024 * 1024 }).trim()
  }

  assertClean() {
    assert.equal(
      this.run({ command: 'git', args: ['status', '--porcelain', '--untracked-files=all', '--', 'packages'] }),
      '',
      'Package sources must have no tracked or untracked changes'
    )
  }

  build() {
    assert.equal(process.argv.length, 3, 'Usage: node benchmark/package-build.js OUTPUT_DIRECTORY')
    const output = path.resolve(process.argv[2])
    assert.ok(!fs.existsSync(output) || fs.readdirSync(output).length === 0, 'Output directory must be empty')
    this.assertClean()
    const commit = this.run({ command: 'git', args: ['rev-parse', 'HEAD'] })
    const tree = this.run({ command: 'git', args: ['rev-parse', 'HEAD^{tree}'] })
    const suffix = `-perf.20261114.g${commit.slice(0, 12)}`
    const sources = Object.fromEntries(
      names.map((name) => [
        name,
        JSON.parse(fs.readFileSync(path.join(root, 'packages', name, 'package.json'), 'utf8')),
      ])
    )
    const versions = Object.fromEntries(names.map((name) => [name, sources[name].version + suffix]))
    this.run({ command: path.join(root, 'node_modules', '.bin', 'tsc'), args: ['--build'] })
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'nodepg-package-build-'))
    fs.mkdirSync(output, { recursive: true })
    try {
      const packages = {}
      for (const name of names) {
        const stage = path.join(temporary, name)
        fs.mkdirSync(stage)
        const original = JSON.parse(
          this.run({
            command: 'npm',
            args: ['pack', '--ignore-scripts', '--json', '--pack-destination', stage],
            cwd: path.join(root, 'packages', name),
          })
        )[0]
        // Only extract tarballs produced locally by npm pack from the clean checkout.
        this.run({ command: 'tar', args: ['-xzf', path.join(stage, original.filename), '-C', stage] })
        const directory = path.join(stage, 'package')
        const manifestPath = path.join(directory, 'package.json')
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
        manifest.version = versions[name]
        for (const section of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
          for (const dependency of Object.keys(manifest[section] || {})) {
            if (versions[dependency]) manifest[section][dependency] = versions[dependency]
          }
        }
        fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
        const packed = JSON.parse(
          this.run({
            command: 'npm',
            args: ['pack', '--ignore-scripts', '--json', '--pack-destination', output],
            cwd: directory,
          })
        )[0]
        packages[name] = {
          version: versions[name],
          filename: packed.filename,
          sha256: createHash('sha256')
            .update(fs.readFileSync(path.join(output, packed.filename)))
            .digest('hex'),
        }
      }
      this.assertClean()
      assert.equal(
        this.run({ command: 'git', args: ['rev-parse', 'HEAD'] }),
        commit,
        'Source commit changed during packaging'
      )
      const manifest = {
        sourceCommit: commit,
        sourceTree: tree,
        node: process.version,
        npm: this.run({ command: 'npm', args: ['--version'] }),
        defaultInstall: names,
        packages,
        limitations: 'Experimental coordinated Node.js package set. No native bindings or browser/worker adapters.',
      }
      fs.writeFileSync(path.join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
      console.log(JSON.stringify(manifest, null, 2))
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true })
    }
  }
}

try {
  new PackageBuilder().build()
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
