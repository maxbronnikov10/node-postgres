'use strict'

// A/B of two checkouts of this repo against the same database: the pg of `--head` over the pg of
// `--base`, scenario by scenario. Both arms run on the same machine in the same run, so what the
// machine does moves them together and the ratio holds still; that is the only number worth
// reading on a hosted runner, where the absolute queries per second are never the same twice.
//
// Each arm runs twice, in two processes, so every round also measures base against base and head
// against head: the same code on both sides, so whatever those ratios do is the noise of this
// run on this machine, and a head/base ratio is marked only when it moved further than that.
// All four stay up but only one measures at a time, the others wait: the load alternates between
// them one scenario at a time, in an order that changes every round, so the measurements behind
// a ratio are seconds apart and a drift of the machine lands on all of them. The reported
// speedup is the median of the per-round ratios.

const fs = require('fs')
const os = require('os')
const path = require('path')
const assert = require('assert/strict')
const { execFileSync, fork } = require('child_process')

// below this nothing is marked whatever the noise said: a same-code band can come out very
// narrow by luck on a handful of rounds, and a change this small is not worth a look anyway
const FLOOR = 0.02

const parseArgs = (argv) => {
  const args = {}
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i].slice(2)
    if (
      !argv[i].startsWith('--') ||
      !['base', 'head', 'rounds', 'duration', 'warmup', 'output', 'profile', 'scenario', 'json-output'].includes(name)
    ) {
      throw new Error(`unknown argument: ${argv[i]}`)
    }
    if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`missing value for --${name}`)
    args[name] = argv[++i]
  }
  return args
}

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

const label = (dir) => {
  try {
    return execFileSync('git', ['-C', dir, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim()
  } catch {
    return path.basename(path.resolve(dir))
  }
}

// one worker per arm, driven by messages: each send resolves with the worker's reply
const startArm = ({ dir, index, profile }) => {
  const child = fork(path.join(__dirname, 'worker.js'), [], {
    execArgv: ['--expose-gc'],
    env: { ...process.env, PG_BENCH_MODULE: path.resolve(dir), PG_BENCH_ARM: String(index), PG_BENCH_PROFILE: profile },
  })
  const waiting = []
  child.on('message', (msg) => {
    const { resolve, reject } = waiting.shift()
    msg.ok ? resolve(msg) : reject(new Error(msg.error))
  })
  child.on('error', (error) => {
    for (const { reject } of waiting.splice(0)) reject(error)
  })
  child.on('exit', (code) => {
    for (const { reject } of waiting.splice(0)) reject(new Error(`worker for ${dir} exited with ${code}`))
  })
  const ready = new Promise((resolve, reject) => waiting.push({ resolve, reject }))
  return {
    ready,
    stop: () =>
      new Promise((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) return resolve()
        child.once('exit', resolve)
        child.kill()
      }),
    send: (msg) =>
      new Promise((resolve, reject) => {
        waiting.push({ resolve, reject })
        child.send(msg)
      }),
  }
}

const percent = (ratio) => `${ratio >= 1 ? '+' : ''}${((ratio - 1) * 100).toFixed(1)}%`

const markdown = ({ labels, rows, rounds, duration, profile }) => {
  const lines = ['<!-- benchmark-comment -->', '', `## Benchmark: \`${labels.head}\` against \`${labels.base}\``, '']
  const unit = profile === 'tls-handshake' ? 'connections/s' : profile === 'queue' ? 'operations/s' : 'q/s'
  lines.push(`Profile: ${profile}.`)
  if (process.env.PG_BENCH_ENDPOINT) lines.push(`Endpoint: ${process.env.PG_BENCH_ENDPOINT} (descriptive label).`)
  if (profile === 'ablation') {
    lines.push(
      'Same checkout on all arms. Base: pipeline only. Head: named option combination; identical transaction workload.'
    )
  } else if (profile === 'regression') {
    lines.push(
      'Baseline checkouts may ignore unsupported optimization options; these rows do not imply baseline support.'
    )
  } else if (profile === 'tls-handshake') {
    lines.push(
      'Same checkout, verified TLS 1.3. Context row: base fresh context, head shared context, both postgres negotiation. Negotiation row: base postgres, head direct, both shared context.'
    )
    lines.push('Each connection includes connect, one SELECT and close. No session resumption is implemented.')
  } else if (profile === 'tls-steady') {
    lines.push(
      'Before/after checkouts, identical pipeline true and maxAutoPrepare 16 options. Verified TLS 1.3, shared context, direct negotiation; steady connections, SELECT-only.'
    )
  } else if (profile === 'rows') {
    lines.push(
      'Before/after checkouts, identical text result format, named statements and row shapes. Rates count queries, with the stated fixed row count per query. Every field is consumed and checked.'
    )
  } else if (profile === 'row-formats') {
    lines.push(
      'Same checkout. Base: text results. Head: binary results. Named statements on both arms, no pipeline. A binary bytea codec is supplied explicitly; other codecs use pg-types. Rates count queries, not rows.'
    )
  } else if (profile === 'executor') {
    lines.push(
      'Same checkout. Base: Pool.query, max 4. Head: QueryExecutor, max 4, depth 16, maxPending 1024. Both use pipeline true, maxAutoPrepare 16 and the same logged table; no BEGIN. Four frontend connections are prewarmed and every result is checked.'
    )
    if (process.env.PG_BENCH_TLS_CA) lines.push('Verified TLS 1.3, shared context on both arms.')
    if (process.env.PG_BENCH_DELAY_MS !== undefined)
      lines.push(
        `Opaque TCP relay delays application bytes by ${process.env.PG_BENCH_DELAY_MS} ms per direction; excludes TCP handshake, bandwidth limits and packet loss.`
      )
  } else if (profile === 'autocommit') {
    lines.push('Default options on both checkouts; independent queries without BEGIN. Pool max: 4; concurrency: 16.')
  } else if (profile === 'executor-regression') {
    lines.push(
      'Before/after QueryExecutor on both arms: max 4, depth 16, maxPending 1024, maxAutoPrepare 16, target any. Four warmed frontends, checked results, no BEGIN. Actors run sequentially and update identical fixed keys.'
    )
  } else if (profile === 'autocommit-prepare') {
    lines.push(
      'Same checkout. Base: maxAutoPrepare 0. Head: maxAutoPrepare 16. Pipeline disabled; no BEGIN. Pool max: 4; concurrency: 16.'
    )
  } else if (profile === 'autocommit-pipeline') {
    lines.push(
      'Same checkout. Base: pipeline false. Head: pipeline true. Both use maxAutoPrepare 16; no BEGIN. One client, concurrency: 16.'
    )
  }
  lines.push('')
  lines.push(`| Scenario | Base ${unit} | Head ${unit} | Head / base | Rounds | Noise |`)
  lines.push('| --- | ---: | ---: | ---: | ---: | ---: |')
  for (const row of rows) {
    const mark = row.notable ? (row.speedup < 1 ? ' :eyes:' : ' :trophy:') : ''
    const change = row.notable ? `**${percent(row.speedup)}**` : percent(row.speedup)
    lines.push(
      `| ${row.name}${mark} | ${row.base.toFixed(0)} | ${row.head.toFixed(0)} | ` +
        `${row.speedup.toFixed(3)}x (${change}) | ${row.min.toFixed(2)} to ${row.max.toFixed(2)} | ` +
        `±${(row.noise * 100).toFixed(1)}% |`
    )
  }
  lines.push('')
  lines.push(
    `${rounds} rounds of ${duration}s per scenario, each round measuring base, head and a second process of ` +
      `each one after the other, in an order that changes every round. "Head / base" is the median of the ` +
      `per-round ratios and "Rounds" their range. "Noise" is how far base/base and head/head, the same code on ` +
      `both sides, got from 1 in this same run: that is what the machine did, so a row is marked only when the ` +
      `median moved further than that, at least ${Math.round(FLOOR * 100)}%, and every round moved the same ` +
      `way: :eyes: slower, :trophy: faster. Only the ratio is comparable across runs, the absolute rates depend ` +
      `on the runner.`
  )
  lines.push('')
  lines.push(`Node ${process.version}, ${os.cpus()[0]?.model || 'unknown cpu'}, ${os.cpus().length} cores.`)
  return lines.join('\n') + '\n'
}

const main = async () => {
  const args = parseArgs(process.argv.slice(2))
  if (!args.base || !args.head) {
    throw new Error(
      'usage: node benchmark/compare.js --base <dir> --head <dir> [--rounds 4] [--duration 3] [--output file] [--json-output file] [--scenario label] [--profile regression|ablation|queue|payload|autocommit|autocommit-prepare|autocommit-pipeline|tls-handshake|tls-steady|rows|row-formats|executor]'
    )
  }
  const rounds = Number(args.rounds || 4)
  const duration = Number(args.duration || 3)
  const warmup = Number(args.warmup || 1)
  const profile = args.profile || 'regression'
  if (
    ![
      'regression',
      'ablation',
      'queue',
      'payload',
      'autocommit',
      'autocommit-prepare',
      'autocommit-pipeline',
      'tls-handshake',
      'tls-steady',
      'rows',
      'row-formats',
      'executor',
      'executor-regression',
    ].includes(profile)
  ) {
    throw new Error(`unknown profile: ${profile}`)
  }
  if (!Number.isSafeInteger(rounds) || rounds < 1) throw new Error('--rounds must be a positive integer')
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('--duration must be positive')
  if (!Number.isFinite(warmup) || warmup <= 0) throw new Error('--warmup must be positive')
  if (
    ['ablation', 'autocommit-prepare', 'autocommit-pipeline', 'tls-handshake', 'row-formats', 'executor'].includes(
      profile
    ) &&
    fs.realpathSync(args.base) !== fs.realpathSync(args.head)
  ) {
    throw new Error(`--profile ${profile} requires --base and --head to name the same checkout`)
  }
  if (['tls-handshake', 'tls-steady'].includes(profile) && !process.env.PG_BENCH_TLS_CA) {
    throw new Error('PG_BENCH_TLS_CA is required for TLS benchmarks')
  }
  const labels = { base: label(args.base), head: label(args.head) }

  // two processes per arm: base2 and head2 are the same code as base and head, measured
  // alongside them so the run can tell how much two identical arms differ on this machine
  const arms = {}
  const names = ['base', 'head', 'base2', 'head2']
  let ended = false
  try {
    for (const [index, name] of names.entries()) {
      arms[name] = startArm({ dir: index % 2 === 0 ? args.base : args.head, index, profile })
    }
    const ready = await Promise.all(names.map((name) => arms[name].ready))
    const { scenarios } = ready[0]
    for (const arm of ready) assert.deepEqual(arm.scenarios, scenarios)
    if (args.scenario && !scenarios.includes(args.scenario)) {
      throw new Error(`unknown scenario: ${args.scenario}; available: ${scenarios.join('; ')}`)
    }
    await arms.base.send({ type: 'setup' })

    const ratio = (qps, over, under) => qps[over].map((value, i) => value / qps[under][i])
    const rows = []
    for (const scenario of args.scenario ? [args.scenario] : scenarios) {
      process.stderr.write(`${scenario}\n`)
      const qps = Object.fromEntries(names.map((name) => [name, []]))
      for (let i = -1; i < rounds; i++) {
        // the first round is a warmup on cold code and is thrown away
        const ms = (i < 0 ? warmup : duration) * 1000
        // rotates one place per round and flips on odd rounds, so each arm sees every position
        const rotated = names.map((_, k) => names[(k + i + 1) % names.length])
        const order = i % 2 ? rotated.reverse() : rotated
        for (const arm of order) {
          const reply = await arms[arm].send({ type: 'run', scenario, ms })
          if (i >= 0) qps[arm].push(reply.qps)
        }
      }
      const ratios = ratio(qps, 'head', 'base')
      const same = [...ratio(qps, 'base2', 'base'), ...ratio(qps, 'head2', 'head')]
      const speedup = median(ratios)
      const min = Math.min(...ratios)
      const max = Math.max(...ratios)
      const noise = Math.max(...same.map((value) => Math.abs(value - 1)))
      process.stderr.write(
        `  ${speedup.toFixed(3)}x (${min.toFixed(2)} to ${max.toFixed(2)}), noise ±${(noise * 100).toFixed(1)}%\n`
      )
      rows.push({
        name: scenario,
        base: median(qps.base),
        head: median(qps.head),
        speedup,
        min,
        max,
        noise,
        notable: Math.abs(speedup - 1) >= Math.max(noise, FLOOR) && (min > 1 || max < 1),
        samples: qps,
      })
    }
    await Promise.all(names.map((name) => arms[name].send({ type: 'end' })))
    ended = true

    if (args['json-output']) {
      const checkouts = Object.fromEntries(
        ['base', 'head'].map((name) => {
          const [commit, tree] = execFileSync('git', ['-C', args[name], 'rev-parse', 'HEAD', 'HEAD^{tree}'], {
            encoding: 'utf8',
          })
            .trim()
            .split('\n')
          return [name, { commit, tree }]
        })
      )
      fs.writeFileSync(
        args['json-output'],
        JSON.stringify(
          {
            schemaVersion: 1,
            profile,
            rounds,
            durationSeconds: duration,
            warmupSeconds: warmup,
            node: process.version,
            cpu: { model: os.cpus()[0]?.model || 'unknown cpu', cores: os.cpus().length },
            checkouts,
            rows,
          },
          null,
          2
        ) + '\n'
      )
    }

    const summary = markdown({ labels, rows, rounds, duration, profile })
    process.stdout.write(summary)
    if (args.output) fs.writeFileSync(args.output, summary)
  } finally {
    if (!ended) await Promise.all(Object.values(arms).map((arm) => arm.stop()))
  }
}

module.exports = { parseArgs }

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`${err.stack || err}\n`)
    process.exit(1)
  })
}
