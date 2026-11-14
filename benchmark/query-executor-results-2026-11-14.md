# Independent-query executor and TLS follow-up, 2026-11-14

`pg.QueryExecutor` is an opt-in scheduler for many independent statements outside
transactions. It pipelines over a bounded set of frontend connections; ordinary
Pool.query still leases a client exclusively. Transactions, COPY, cursors and
session state keep their exclusive-client API.

Implementation: `8fb79c29`; TLS identity fix: `e7fbae09`; initial benchmark harness:
`0f5ba573`, with warmup/activity accounting corrected in `eb4e4dc9`.
[API reference](../docs/pages/apis/query-executor.mdx),
[cross-language comparison](driver-survey-2026-11-14.md).

```js
const executor = new pg.QueryExecutor({
  max: 4,
  maxInFlightPerConnection: 16,
  maxPending: 1024,
  maxAutoPrepare: 16,
  query_timeout: 30000,
  ssl: { secureContext, rejectUnauthorized: true },
})
try {
  const results = await Promise.all(ids.map((id) => executor.query('SELECT value FROM items WHERE id = $1', [id])))
} finally {
  await executor.end()
}
```

The context and application ids/SQL above are caller-owned. Direct TLS negotiation
is optional and requires a compatible endpoint. The example does not introduce
an implicit credential/context cache or weaken certificate checks.

## Comparison controls

Node v22.22.1 on a shared four-core AMD EPYC-Rome runner; PostgreSQL 18.7,
PgBouncer 1.25.2. Test services and TLS keys are disposable. No application database,
host packages or production TLS configuration was changed.
[Captured service settings](fixture-disrupt-2026-11-14.json),
[machine-readable validation](validation-disrupt-2026-11-14.json).

Both arms run the same checkout and query results are checked. Base is Pool.query
with max 4; head is QueryExecutor with max 4, depth 16, maxPending 1024. Both use
pipeline true, maxAutoPrepare 16 and a 1024-row logged table. Four frontend
connections are warmed before timing, with the point query present in each
frontend's bounded preparation cache. Fresh SQL uses monotonically increasing
comments; all caches are full before that case. UPDATE uses separate per-actor
id ranges, sets value 7 and checks RETURNING id/value. No BEGIN is sent.

There are two processes per arm, measured one at a time in changing order, four
two-second rounds plus warmup. Reported speedup is the median of paired ratios;
absolute q/s columns are separate medians and need not divide to the ratio. Noise
is the largest deviation of duplicate same-code controls from 1. A marked result
must beat that band and 2%, with every round in the same direction. This is not a
confidence interval, nor a cross-language benchmark.

TLS fixes the protocol to 1.3, reuses an explicit secureContext, verifies CA/hostname,
asserts authorized true and checks ALPN postgresql in direct mode. PgBouncer runs
transaction pooling with four backend slots, max_prepared_statements 200 and
verify-full backend TLS; SHOW CONFIG/SERVERS/STATS and backend replacement are
checked separately. PostgreSQL durability settings remain enabled.

The delay fixture forwards opaque TCP bytes with an independent 3 ms delay per
direction and honors backpressure. It preserves TLS end to end. This models
application-byte propagation, not TCP connection RTT, real WAN bandwidth, packet
loss or congestion. Its self-check covers split bytes, independent delays, 4 MiB
backpressure, half-close and teardown.

## Throughput

[PostgreSQL loopback](results-executor-postgres-2026-11-14.md): concurrent prepared
SELECT improved 45.4% (1.42–2.02x, controls ±31.6%); fresh SQL improved 34.6%
(1.30–1.40x, controls ±12.0%). Sequential +2.7% and logged UPDATE +18.2% remained
inside their control bands. There is no established universal gain for low load
or writes from this run.

[Verified TLS with delay](results-executor-tls-delay-2026-11-14.md): concurrent
prepared SELECT 3.742x (3.57–4.04x, controls ±11.5%), fresh SQL 3.500x
(3.28–3.68x, ±4.3%), logged UPDATE 2.693x (2.52–3.03x, ±12.0%). All three clear
their control bands. Sequential +3.3% stays inside ±7.9% controls.

[Transaction-mode PgBouncer with TLS](results-executor-pgbouncer-tls-2026-11-14.md):
fresh SQL +43.4% (1.37–1.45x, ±32.2%) clears its control band. Concurrent prepared
SELECT +47.7%, sequential +6.2% and UPDATE +9.4% remain inside wider controls.
The same four frontend connections and SQL controls apply. A positive median
alone is not treated as an established improvement.

## Latency and overload

The offered-load harness schedules fixed-rate arrivals from a monotonic clock.
Latency starts at intended arrival, including generation lag and queue wait.
Success and rejection histograms are separate; quick overload rejection cannot
artificially improve successful-query percentiles. Histograms retain bounded
statistics, not an array of every request duration. Results include offered and
completed counts, drain time, queue/activity peaks, event-loop p99 and observed
heap growth. Heap samples use fixed small parameters and are observations rather
than a hard byte limit for arbitrary caller data.

[Raw fixed-load results](results-executor-load-2026-11-14.json): 1000 requests/s
for five seconds, verified TLS 1.3, 3 ms relay delay per direction, four connections
on both arms. Separate fresh processes ran in Pool/executor/executor/Pool order.

| Measure | Pool.query, two trials | QueryExecutor, two trials |
| --- | ---: | ---: |
| Completed / offered | 5000 / 5000 each | 5000 / 5000 each |
| Rejections | 0 | 0 |
| Successful-query p95 | 5407–5485 ms | 11.03–11.51 ms |
| Successful-query p99 | 5595–5734 ms | 12.41–13.02 ms |
| Peak waiting | 2730–2772 | 0 |
| Peak active/assigned | 4 | 16–17 |
| Drain after arrivals stop | 5644–5795 ms | 7.63–9.19 ms |
| Observed heap growth | 19.85–19.88 MiB | 10.75–10.79 MiB |

The offered rate exceeds the four-client Pool's capacity in this delay fixture,
so its queue grows; the executor has headroom. This is a capacity/queueing result,
not a claim that one isolated SQL execution became hundreds of times faster.
The successful-query histogram includes all completions during drain as well.

[Raw overload results](results-executor-overload-2026-11-14.json): two executor
processes, each receiving 20,000 requests/s for five seconds, maxPending 64 and
64 total assigned slots. The queue and assignment peaks were exactly 64 in both.
Of 100,000 offered requests per trial, 21,866 / 24,411 completed and 78,134 /
75,589 rejected solely as PG_EXECUTOR_OVERLOADED/not-sent. Every accepted task
completed; drain took 17.65–19.58 ms. Successful p99 was 40.93–59.23 ms; rejection
p99 was separately 5.28–11.39 ms. Observed heap growth was 20.83–21.39 MiB for
these fixed small requests. No unknown/timeout error or unhandled rejection occurred.

The audit also caught two benchmark defects before these load results: Pool has
no inFlightCount, so activity is measured as leased clients; and warming a queue
smaller than 64 now opens clients with at most one waiting task. Real smoke checks
passed at maxPending 1 and confirmed four active Pool queries. Those corrections
do not change the timed query bodies of the earlier throughput comparisons.

## Failure behavior and regression evidence

All 27 executor cases passed against PostgreSQL. They cover ordered UTF-8/binary
results with an intervening server error, queue saturation, unsent writes,
already-aborted/queued cancellation, deadlines, replacement connections, frozen
encoder errors, graceful drain and forced shutdown. In-flight cancellation drops
the shared connection and can fail collateral assigned tasks. The server may
continue its statement; no per-query PostgreSQL cancellation is claimed.

A TCP fault fixture forwards an INSERT's command completion but drops its following
ReadyForQuery, after the write committed. The executor reports unknown, reconnects
on later work and never replays that operation. A separate control observes exactly
one row for its non-unique marker, both before and after reconnection.

Backend termination reports assigned work as unknown. A queued unsent INSERT can
execute once on replacement; counts drain and later SELECT succeeds. A blackhole
endpoint bounds opening attempts, rejects unsent work and recovers when the same
endpoint becomes healthy. Another fixture withholds graceful close: destroy now
interrupts an earlier end and resolves its original shutdown Promise. The new
shutdown regression failed before that fix.

The TLS follow-up preserves explicit ssl.servername even when the connection uses
a different DNS alias, and preserves an explicitly empty SNI name. Both new real
TLS handshake tests fail with the former condition and pass with trusted CA and
normal hostname verification. The existing direct PostgreSQL and PgBouncer checks
reject an incorrect name/untrusted CA, preserve query error isolation, and confirm
cached named execution after PgBouncer replaces its backend. A warmed 16-query
pipeline still produces one client TLS application record, 1276 encrypted bytes.

[TLS connection cycles with delay](results-tls-handshake-delay-2026-11-14.md)
use a shared opaque relay adding 3 ms per direction. Direct rather than postgres
negotiation gives 1.206x completed cycles/s (1.19–1.24x, controls ±2.6%). Each cycle
includes connection, SELECT and close; this is not steady-state query throughput.
Shared versus fresh context is 1.001x inside ±5.4% controls in this delayed case.
Both options already existed; these measurements isolate configuration choices.
Session resumption is not implemented.

The integrated source passed 947 enabled cases: 649 pg unit/integration, 104
protocol, 93 pool, 43 cursor, 40 query-stream, 15 native-specific and three actual
workerd runtime cases. One pool case remains pre-existing pending; optional SCRAM
roles were not configured. Build/lint and CommonJS/ESM export/native-isolation
checks passed. The new executor is JS-only and feature-checks events.addAbortListener
at construction; the actual workerd cases exercise existing Client compatibility.

## Reproduce

Build the workspace with corepack yarn build. Set PGHOST, PGPORT, PGUSER and
PGDATABASE to a disposable database. For TLS also set PG_BENCH_TLS_CA; an explicit
PG_BENCH_TLS_SERVERNAME can name the certificate identity of a proxy endpoint.

```bash
node benchmark/compare.js --base . --head . --profile executor --rounds 4 --duration 2 --warmup 0.5
PG_BENCH_DELAY_MS=3 node benchmark/compare.js --base . --head . --profile executor --rounds 4 --duration 2 --warmup 0.5
PG_BENCH_DELAY_MS=3 PG_BENCH_LOAD_RATE=1000 node --expose-gc benchmark/executor-load.js . pool
PG_BENCH_DELAY_MS=3 PG_BENCH_LOAD_RATE=1000 node --expose-gc benchmark/executor-load.js . executor
PG_BENCH_DELAY_MS=3 PG_BENCH_LOAD_RATE=20000 node --expose-gc benchmark/executor-load.js . executor
```

For the delayed handshake comparison, run one DelayedProxy from
benchmark/delayed-proxy.js around the endpoint, point PGPORT at its loopback port,
and run the tls-handshake profile through it. The delay is external to that
profile; PG_BENCH_DELAY_MS is interpreted by the executor workload only. Keep
certificate verification and close the proxy after child processes exit.

TLS checks issue RECONNECT only for the explicitly allowed disposable nodepg_tls/
nodepg_survey PgBouncer fixtures. They must not be run against a production endpoint.
No npm packages or remote branches were published. The client/protocol/cursor
changes require a coordinated package release, including the new protocol export;
external @types/pg declarations have not been updated in this monorepo.
