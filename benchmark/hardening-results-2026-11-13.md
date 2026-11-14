# Combined optimization hardening, 2026-11-13

Branch: `perf/combined-optimizations`. Upstream baseline: `2a5850fb`.
Final implementation: `db6a3712`; subsequent report commits do not change the implementation.
Performance runs use `7aed08ba`. The follow-up commit changes only native error
provenance and its regression tests; these JavaScript benchmarks do not use native bindings.
All measurements use Node v22.22.1 on the same shared four-core AMD EPYC-Rome runner.
Database workloads use a temporary local PostgreSQL 18.7 container over TCP without TLS.
These are local workload measurements, not production capacity estimates.

## Changes

- Ordinary pipelining pauses encoding when the Node stream needs drain. Already-sent
  responses still complete, queued timeouts leave a healthy connection usable, and
  transport failure removes the drain listener and rejects pending work.
- Batch failures use internal query positions. Frozen, read-only or reused Error
  metadata cannot redirect an error to the wrong query. Optional stack rewriting in
  Client, Pool and native Promise paths preserves the original Error.
- Converter and row-parser throws such as `null` reject with an Error whose `cause`
  preserves the thrown value. Native conversion failures reject the query Promise
  through the existing completion path and leave the connection usable.
- Local native validation/conversion failures do not inherit SQLSTATE, message or
  severity from a previous server error. This also preserves frozen errors after
  a server failure; native attachment occurs only after local preflight succeeds.
- Oversized batch chunks use Node stream cork/writev, avoiding the extra aggregate
  payload copy. Streams without cork retain the existing concatenation path.
- DELETE benchmarks restore each arm's bounded ID range outside timing and require
  one affected row. New queue, option-ablation and payload profiles validate results;
  failed benchmark startup/measurement cleans up sibling processes.

## Options

`pipelineBatchWrites` was removed, including its implementation, tests and API docs.
Its isolated transaction comparison was -4.4%, with ratios 0.84–1.05 and same-code
noise ±30.9%. The additional option and next-tick scheduling had no demonstrated gain.
The historical [five-option run](results-options-2026-11-13.md) is pinned to `209b87c3`,
where that option still existed. The final ablation profile has three comparisons.

Pool queue/handoff, query-config normalization, error fixes and large-payload copy
avoidance are unconditional. The remaining choices carry observable semantics:

- `pipeline` remains the existing opt-in API with its documented portal/custom-query restrictions.
- `autoBatch` stays opt-in: a converter failure can skip a following INSERT with
  `PG_BATCH_ABORTED`; ordinary serial/pipelined queries can still execute that INSERT.
- `maxAutoPrepare` remains a numeric cache limit, default zero. A cached `SELECT *`
  can raise `0A000: cached plan must not change result type` after ALTER TABLE,
  while an ordinary unnamed query accepts the new result shape.
- `client.batch()` is an explicit batching API and needs no additional enable flag.

The semantic differences above are regression-tested against the real database.

## Measurements

All comparisons alternate four separate worker processes, two per code/option arm,
and use same-code pairs to estimate noise. A result is marked only if its median
exceeds both 2% and observed noise, with every round moving in the same direction.
This is a conservative run-specific check, not a confidence interval.

| Workload | Median change | Per-round ratio | Same-code noise | Interpretation |
| --- | ---: | ---: | ---: | --- |
| autoBatch + automatic prepare, transaction of 10 parameterized SELECTs | +86.6% | 1.65–3.19 | ±50.3% | Exceeds this run's control band; shared runner is noisy |
| Explicit batch, 2 × 8 MiB Buffer parameters, after copy avoidance | +16.0% | 1.15–1.18 | ±10.6% | Exceeds control band |
| Explicit batch, 2 × 1 MiB Buffer parameters | +20.4% | 1.01–1.25 | ±21.9% | Inconclusive |
| Pool FIFO, queue depth 10,000 | +22.1% | 1.12–1.25 | ±15.1% | Exceeds control band |
| Pool timeout churn, queue depth 10,000 | +69.9% | 1.47–1.79 | ±13.3% | Exceeds control band |

The ablation compares options within `209b87c3`, using the same BEGIN, ten SELECTs
and COMMIT on every arm. Individual autoBatch (+72.9%, noise ±108.3%) and automatic
prepare (+23.0%, noise ±34.9%) were inconclusive. The combined option result does
not establish either one's independent contribution.

The [payload comparison](results-payload-2026-11-13.md) compares `209b87c3` against
`7aed08ba`; both have the batch API and identical default query semantics for this
workload. Four rounds of two seconds, 0.5-second warmup; four SQL commands per iteration.
The copy-volume probe measured **16,777,380 → 0 Buffer.concat bytes** for two 8 MiB
parameters. This counts aggregate copies, not all allocations or peak memory.

The [queue comparison](results-queue-2026-11-13.md) compares upstream against
`7aed08ba`, four rounds of one second with 0.5-second warmup. It runs real Pool
acquisition/release/timeout code with a fake transport to isolate queue costs.
Rates are settled queued checkouts per second, including timeouts, not SQL throughput.
Queue depth 10 showed no confirmed gain. Depth 1,000 FIFO was also inconclusive;
its timeout-churn result was +10.2%, noise ±8.8%.

The [final 21-scenario database comparison](results-final-2026-11-13.md) uses the
same upstream baseline and final implementation. It includes default queries,
row/parameter parsing, transactions, pool contention, cursors and streams, plus
explicit opt-ins. Unsupported upstream batch options use the documented ordinary
pipeline fallback; those rows compare APIs, not identical implementations.
It uses four 0.5-second rounds and a 0.25-second warmup. The longer combined queue
and database command received SIGTERM before completing; its partial database
output is not treated as a completed comparison.
Five of 21 scenarios exceeded this run's control band: one-row prepared SELECT
(+13.6%), automatic preparation (+40.4%), explicit batch (+54.8%), named-cache batch
(+51.3%) and autoBatch with preparation (+113.6%, ratios 2.07–2.41, noise ±14.6%).
No slowdown exceeded that band. Several slower medians remain inconclusive;
this short, noisy run cannot rule out smaller regressions.

## Verification

1,003 test cases passed, plus benchmark assertions and lifecycle self-checks:

| Suite | Passed |
| --- | ---: |
| pg unit, 27 files | 302 |
| pg JavaScript integration, 86 files | 298 |
| pg native-specific, 5 files | 15 |
| pg native integration, 86 files | 214 |
| pg-pool | 93 |
| pg-protocol | 78 |
| Actual Cloudflare Worker runtime | 3 |

The pool suite retains one pre-existing pending test. JS-only features are excluded
from native mode. Native bindings were built and tested against libpq.
`yarn build`, `yarn lint` and `git diff --check` passed. TLS-specific integration
tests were disabled with `PGTESTNOSSL=true`; SSL/SCRAM roles were configured for
the remaining integration tests.

An additional real TLS check validated two 8 MiB parameters with autoBatch and
preparation, frozen converter-error identity, rollback and subsequent query reuse.
It used a temporary self-signed certificate with `rejectUnauthorized: false`;
certificate verification and TLS throughput were not evaluated.

The new regressions were reproduced before their fixes: stalled pipeline buffering,
frozen/reused Error routing, frozen Promise stack rewriting, synchronous native
conversion throws, a converter throwing null silently succeeding, and a local
native error inheriting SQL fields from a previous server failure.

## Reproduce

Both checkouts must have dependencies installed and TypeScript packages built.
Use the same PGHOST, PGPORT, PGUSER and PGDATABASE for database workloads.

```bash
node benchmark/queue-check.js
node benchmark/queue-check.js ../node-postgres-upstream
node benchmark/payload-copy-check.js ../node-postgres-209b87c3
node benchmark/payload-copy-check.js .
node benchmark/compare.js --base ../node-postgres-209b87c3 --head . --profile payload --rounds 4 --duration 2 --warmup 0.5
node benchmark/compare.js --base ../node-postgres-upstream --head . --profile queue --rounds 4 --duration 1 --warmup 0.5
node benchmark/compare.js --base ../node-postgres-upstream --head . --rounds 4 --duration 0.5 --warmup 0.25
```

For the original five-way option comparison, run `--profile ablation --base . --head .`
from revision `209b87c3`, four rounds of three seconds with one-second warmup.

## Remaining work

- Bound caller concurrency: socket backpressure bounds encoded outgoing chunks,
  but application-created Query objects and pool waiters can still accumulate.
  A driver queue limit needs an explicit overload/error contract; none was added here.
- Measure automatic preparation on the application's actual SQL and parameter
  distribution before choosing a limit. Cached generic plans, schema changes and
  proxy pooling behavior can change the tradeoff.
- Validate representative WAN/TLS workloads and long-running failure/reconnection
  scenarios. Cloudflare's large-payload backpressure was not load-tested.
- Remote publication remains unavailable to `aicopilot-fr` on this fork. The local
  branch and Git bundle contain the complete change; no remote branch or PR is claimed.
