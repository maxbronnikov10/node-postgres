# Benchmark

A/B of two checkouts of this repo against the same database: the `pg`, `pg-pool`, `pg-cursor` and
`pg-query-stream` of `--head` over the same packages of `--base`, scenario by scenario. The CI runs
it on every pull request with the base branch in `--base` and the PR in `--head`, over a unix
socket, and posts the table as a comment on the PR.

Both checkouts must be installed and built (`yarn install && yarn build`). The database comes from
the usual `PG*` environment variables.

```bash
yarn benchmark --base ../node-postgres-master --head . --rounds 4 --duration 3
```

Both arms stay up in their own process and the load alternates between them one scenario at a
time, swapping which goes first on every round, so the two measurements behind a ratio are seconds
apart and a drift of the machine lands on both. Only the ratio is comparable across runs: the
absolute queries per second depend on the machine.

The 21 regression scenarios cover the row parser on every family of type, the parameter encoding on writes,
prepared and unnamed statements, array and binary result modes, transactions, the pool, cursors,
streams and pipeline mode. Each scenario is one iteration of a function in `worker.js`, which
returns how many queries it ran.

Existing scenarios keep their default clients and options to expose regressions. Additional scenarios
exercise config-object queries, `maxAutoPrepare: 16`, explicit `client.batch(configs)`,
`autoBatch: true`, and real pool contention with `max: 1`. Batch clients enable automatic preparation;
the automatic-batch client also enables `autoBatch`. Each new SELECT checks row count, row-array length and returned integer
values. Bursts contain 10 queries. Transaction scenarios await `BEGIN`, submit 10 parameterized SELECTs, await all
results, then await `COMMIT`; their reported count is 12 queries, including transaction control.
Other bursts count 10 queries, not one batch. Pool contention holds the only connected client while
queuing 10 queries, checks the pending queue length, then releases it and consumes every result.

The same worker runs both checkouts. Upstream ignores unsupported client options; when `client.batch`
is absent, the explicit-batch scenarios use `Promise.all(configs.map(config => client.query(config)))`
on a pipeline client inside the same transaction. The automatic-batch scenario uses that submission
pattern on both arms. These rows compare opt-in behavior against upstream's existing API, rather
than claiming upstream implements batching. Named-cache batching prewarms 1000 named SELECTs per
process before timing, then repeatedly batches the first 10 to exercise validation against a larger
statement cache. New scenarios use SELECTs only: their statement names and database state stay
bounded. All additional clients and pools close when the worker ends.

`--profile regression` is the default and keeps all scenarios above. `--profile ablation` isolates
option contributions within one checkout (both paths must resolve to the same directory):

```bash
node benchmark/compare.js --base . --head . --profile ablation --rounds 4 --duration 3
```

Arms 0 and 2 use only `{ pipeline: true }`. Arms 1 and 3 separately request `autoBatch` only,
preparation only (`maxAutoPrepare: 16`), and `autoBatch` plus preparation. These are three independent
comparisons, each against the pipeline-only
control. Each iteration submits exactly the same `BEGIN`, 10 concurrent parameterized SELECTs,
then `COMMIT`; checks literal integer values 0 through 9 and both transaction command tags; and
counts 12 SQL queries. No explicit batch API is used. The profile is a benchmark option forwarded
to workers through `PG_BENCH_PROFILE`, not a driver option. Options unsupported by an upstream
checkout remain ignored in the standard regression profile; those rows compare requested opt-ins
against upstream behavior, not equivalent implementations.

`--profile queue` needs no database and runs only the actual `packages/pg-pool` from each checkout:

```bash
node benchmark/compare.js --base ../node-postgres-master --head . --profile queue --rounds 4 --duration 3
```

A minimal EventEmitter client replaces transport so SQL RTT does not hide queue costs. At depths
10, 1000 and 10000, one checked-out client holds the queue full. FIFO drain serves every waiter;
timeout churn interleaves 1ms-timeout waiters with surviving waiters, waits for expiration, then
drains survivors. The timeout duration and timer scheduling are included in churn measurements.
Both cases check FIFO order, settlement, reuse of the sole client, waiting/total/idle counts, and
empty internal queue storage. One reported operation is one queued checkout settled (success or
timeout), not a SQL query. Pool creation and shutdown occur outside measurements; enqueueing,
timeouts, drain and assertions occur inside. The existing four-process alternating order and
same-code noise control apply unchanged to every profile.

DELETE uses only its arm's 200000 IDs and requires exactly one deleted row. Before each run and
when that range is exhausted, the worker restores the range outside the timed window; it never
wraps into deleted IDs or crosses another arm's range. It also restores the range after each run.
Reported DELETE rates sum only timed windows, excluding fixture reset and GC. Long runs can span
multiple bounded windows; other scenarios retain one continuous window.

Run the small, database-free parsing and queue lifecycle self-check against either checkout:

```bash
node benchmark/queue-check.js
node benchmark/queue-check.js ../node-postgres-master
```

With a database, `node benchmark/payload-copy-check.js [checkout]` measures bytes passed
through `Buffer.concat` while batching two 8 MiB parameters and verifies both results.
This is a copy-volume probe, separate from timing; it does not measure all allocations
or peak memory. Run it in a separate process for each checkout.

## Single queries outside transactions

Three profiles measure independent autocommit queries against a logged table with
1024 indexed rows. They never issue BEGIN or use either batch API. SELECT looks up
one primary key; UPDATE changes a value and returns its key/value. UPDATE targets
are distinct within each 16-query burst and across the four arms, avoiding artificial
row-lock contention. Use a disposable database; setup replaces `benchmark_autocommit_rows`.

| Profile | Base | Head |
| --- | --- | --- |
| `autocommit` | Upstream, default options | Candidate, default options |
| `autocommit-prepare` | Same checkout, `maxAutoPrepare: 0` | Same checkout, `maxAutoPrepare: 16` |
| `autocommit-pipeline` | Same checkout, `pipeline: false` | Same checkout, `pipeline: true` |

The preparation profile keeps pipeline disabled. The pipeline profile enables
`maxAutoPrepare: 16` on both arms. Both option profiles require identical checkout
paths so unrelated code changes cannot explain their ratios.

The first two profiles run sequential Client SELECT, sequential Pool.query SELECT,
16 concurrent Pool.query SELECTs, 16 concurrent Pool.query SELECTs with fresh SQL,
sequential Client UPDATE, and 16 concurrent Pool.query UPDATEs. Pools use max 4.
The pipeline profile runs sequential Client SELECT as a control, then 16 concurrent
Client SELECTs, fresh-SQL SELECTs and UPDATEs on one connection.

Fresh SQL appends a new trailing comment on every call, including across rounds.
The enabled cache is filled before timing so that this case measures cache misses
after the first 16 retained texts. Parameters still vary independently of SQL text.
Every relevant connection is warmed outside timing; transaction status must be `I`,
and the frontend automatic-statement cache must match the requested mode and remain
bounded by 16. Backend names/counts are not used: transaction poolers can rewrite
names and change the assigned backend. Timed queries check row count, returned key and UPDATE
value. Reported rates count individual queries, including all 16 in concurrent cases.
Normal WAL/fsync settings should remain enabled when interpreting write results.

```bash
node benchmark/compare.js --base ../node-postgres-upstream --head . --profile autocommit --rounds 4 --duration 2 --warmup 0.5
node benchmark/compare.js --base . --head . --profile autocommit-prepare --rounds 4 --duration 2 --warmup 0.5
node benchmark/compare.js --base . --head . --profile autocommit-pipeline --rounds 4 --duration 2 --warmup 0.5
```

## TLS and transaction poolers

Set `PG_BENCH_TLS_CA` to a PEM CA file to use verified TLS 1.3 in the autocommit
profiles. `PG_BENCH_ENDPOINT=postgres` or `pgbouncer-transaction` labels the report;
it does not configure the server. TLS profiles require the CA variable and never
disable certificate verification.

`tls-handshake` compares fresh vs shared TLS contexts with postgres negotiation,
then postgres vs direct negotiation with a shared context. It requires the same
checkout on both arms. One operation is a completed connection, including startup,
one verified SELECT and close. The two rows isolate these existing TLS options.

`tls-steady` compares before/after driver checkouts with identical pipeline and
preparation settings, a shared TLS context and direct negotiation. It checks
16 concurrent repeated/fresh/simple SELECTs and two concurrent 1 MiB parameters.
It uses persistent connections and reports individual SQL queries per second.
PostgreSQL must support direct TLS; PgBouncer needs client-side direct TLS support.

```bash
node benchmark/compare.js --base . --head . --profile tls-handshake --rounds 4 --duration 2 --warmup 0.5
node benchmark/compare.js --base ../node-postgres-before-tls --head . --profile tls-steady --rounds 4 --duration 2 --warmup 0.5
```

`node benchmark/tls-check.js [checkout]` is a real TLS regression and record-volume
probe. Besides the CA it needs `untrusted.crt` in the same directory, a separate
untrusted test CA for certificate rejection. It verifies hostname rejection, TLS
authorization, ordered results and independent error boundaries. A transparent
local TCP proxy counts encrypted client-to-server records after warmup; it neither
decrypts nor records keys or plaintext.

For the `pgbouncer-transaction` endpoint, the check requires a disposable database
named `nodepg_tls` and admin access. **It issues RECONNECT for that database** to
verify a cached named query after backend replacement, and checks server-side TLS
and prepared-statement tracking through SHOW CONFIG/SERVERS/STATS. Do not run this
fixture check against production.

The measured fixture uses PostgreSQL 18.7 and PgBouncer 1.25.2 with:

```ini
pool_mode = transaction
default_pool_size = 4
max_prepared_statements = 200
client_tls_sslmode = require
server_tls_sslmode = verify-full
```

Both TLS sides use a temporary CA-signed server certificate valid for localhost
and 127.0.0.1. Certificate/key paths and server TLS CA must be configured on the
fixture; private keys are generated outside the repository. PostgreSQL keeps
fsync and synchronous_commit enabled. Authentication is trust on this isolated
loopback-only fixture, so these tests do not measure SCRAM authentication cost.

`--profile payload` compares two checkouts that both implement `client.batch`:

```bash
node benchmark/compare.js --base ../batch-baseline --head . --profile payload --rounds 4 --duration 3
```

One default Client runs two cases: two 1 MiB Buffer parameters, then two 8 MiB Buffer parameters.
Buffers and query configs are allocated before timing. Each iteration awaits `BEGIN`, explicitly
batches two `SELECT octet_length($1::bytea) AS n` queries, then awaits `COMMIT`. It checks both
transaction command tags, both result row counts and row-array lengths, and exact byte counts
(1048576 or 8388608). Each iteration counts four SQL commands. Setup performs no table writes;
unsupported batch APIs fail during startup instead of falling back to another submission method.

Historical [option results](results-options-2026-11-13.md) measured revision `209b87c3`, before
`pipelineBatchWrites` was removed. Their five ablation variants and standalone write-coalescing
regression row describe that revision; the current benchmark has 21 regression scenarios and
three ablation variants. The historical results are preserved unchanged.
