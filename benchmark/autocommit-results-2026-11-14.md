# Single queries outside transactions, 2026-11-14

Branch: `perf/combined-optimizations`. Workload/comparator revision: `80eb86b4`.
Driver implementation is unchanged from `092d91a5`; this follow-up adds benchmark
profiles and validation only. Upstream comparison baseline: `2a5850fb`.

## Practical result

- For sequential Pool.query requests with repeated SQL, `maxAutoPrepare: 16`
  improved this point-lookup workload by 33.3%; sequential Client requests gained
  43.0%. These changes exceeded their same-code controls.
- For 16 concurrent requests on one Client, pipeline gained 3.130× with repeated
  SQL and 2.186× with fresh SQL. Preparation was identical on both sides.
- Concurrent Pool.query traffic did not establish a preparation gain: its +34.8%
  median was smaller than the observed ±44.3% control noise. Fresh SQL and UPDATE
  preparation results were also inconclusive.
- None of the six default-driver comparisons established a gain or regression
  against upstream. Ordinary Pool.query calls do not become pipelined merely by
  enabling the option on the pool; each call has an exclusive client lease.
- The write tests do not justify a write-throughput claim. In the pipeline UPDATE
  case even the same-code controls varied extremely.

`new Pool({ maxAutoPrepare: 16 })` is therefore a measured option for this repeated
sequential SELECT shape, not a demonstrated general speedup for concurrent pool
traffic. Pipeline needs multiple outstanding queries on one checked-out Client.

## Method

PostgreSQL 18.7 in an isolated cached `postgres:18-alpine` container, direct localhost
TCP without TLS. `fsync`, `synchronous_commit` and `full_page_writes` were all `on`.
The table is ordinary logged storage (`relpersistence = 'p'`), with 1024 rows and a
primary key. Every request is a separate query outside BEGIN. UPDATE includes
normal autocommit/WAL costs; durability settings were not relaxed.

```sql
SELECT id AS n FROM benchmark_autocommit_rows WHERE id = $1;
UPDATE benchmark_autocommit_rows SET value = $1 WHERE id = $2 RETURNING id AS n, value;
```

Sequential cases reuse one key per arm. Concurrent cases submit bursts of 16
independent queries over 16 distinct keys. Pools have max 4, so a burst includes
pool queueing. Each arm owns different keys, and concurrent writes avoid sharing a
row. Fresh SQL adds a unique trailing comment on each call while retaining the
same parameterized point-lookup shape. It tests non-reuse of SQL text, not varied
query complexity or a production SQL distribution.

All relevant connections are prewarmed outside measurement. Every preparation
checks transaction status `I` and server-side automatic-statement counts: zero
when disabled, positive and at most 16 when enabled. The fresh-SQL case fills that
cache first and keeps its SQL counter moving across rounds. Each timed query
checks row count, returned key, and the literal UPDATE value 7.

Four separate worker processes alternate measurements; only one is measured at
a time. Two processes per arm provide same-code noise controls. Each scenario uses
four rounds plus a 0.5-second warmup per process: two-second rounds for the option
profiles and 1.5-second rounds for the default-driver comparison. Reported rates count
individual SQL queries, including every query in a concurrent burst.
The report marks a result only when its median change exceeds both 2% and the
observed control noise and every round moves in the same direction. This is a
run-specific heuristic, not a confidence interval or a production guarantee.

## Preparation: same driver, 0 versus 16 cached SQL texts

Pipeline is disabled on both arms. Both sides load exactly `80eb86b4`.
[Full preparation results](results-autocommit-prepare-2026-11-14.md).

| Workload | Change | Per-round ratio | Control noise | Interpretation |
| --- | ---: | ---: | ---: | --- |
| Sequential Client SELECT | +43.0% | 1.26–1.53 | ±22.4% | Exceeds control band |
| Sequential Pool.query SELECT | +33.3% | 1.28–1.44 | ±13.5% | Exceeds control band |
| Concurrent Pool.query SELECT, 16 requests / 4 clients | +34.8% | 1.19–1.40 | ±44.3% | Inconclusive |
| Concurrent Pool.query SELECT, fresh SQL | +7.1% | 1.03–1.11 | ±8.0% | Inconclusive |
| Sequential Client UPDATE | +17.1% | 0.90–1.20 | ±31.6% | Inconclusive |
| Concurrent Pool.query UPDATE, 16 requests / 4 clients | +13.0% | 1.07–1.24 | ±23.3% | Inconclusive |

Unlike the earlier short constant-SELECT result, this profile isolates preparation
within one driver revision and performs a real table lookup. It confirms a benefit
for this repeated sequential SELECT; it does not establish a general gain for
concurrent pool traffic or autocommit writes.

## Pipeline and default-driver comparisons

The [pipeline comparison](results-autocommit-pipeline-2026-11-14.md) uses one
connection and `maxAutoPrepare: 16` on both arms. It changes only `pipeline`.
The sequential case checks the lack of cross-query overlap; other cases submit
16 independent requests concurrently on that connection.

| Workload | Change | Per-round ratio | Control noise | Interpretation |
| --- | ---: | ---: | ---: | --- |
| Sequential Client SELECT | -10.0% | 0.76–0.98 | ±21.0% | No confirmed gain or slowdown |
| Concurrent Client SELECT, repeated SQL | +213.0% (3.130×) | 2.85–3.24 | ±33.8% | Exceeds control band |
| Concurrent Client SELECT, fresh SQL | +118.6% (2.186×) | 2.06–2.37 | ±17.7% | Exceeds control band |
| Concurrent Client UPDATE | +236.8% | 0.86–19.93 | ±1655.8% | Unusable for a throughput conclusion |

The write comparison has extreme same-code variability, so its positive median
is not evidence of a write-speed gain. The concurrent control without pipeline
also emitted the driver's existing concurrent-query deprecation warning; it is a
measurement baseline, not advice to use that pattern without pipeline.

The [default-driver comparison](results-autocommit-default-2026-11-14.md) loads
upstream `2a5850fb` against `80eb86b4`, with preparation and pipeline disabled on
both. This measures the unconditional queue/handoff/normalization changes rather
than attributing a requested opt-in to the upstream implementation.

Default-driver medians ranged from -6.3% to +8.8%, with control noise from ±11.5%
to ±27.0%; all round ranges crossed 1. Sequential Pool.query SELECT was -4.5%
(noise ±11.5%), and concurrent Pool.query SELECT was -6.3% (noise ±19.8%). These
figures cannot establish either a gain or a slowdown on this runner.

## Validation and reproduction

All 16 scenario combinations passed an initial smoke run, including actual query
results, idle transaction status, requested preparation mode and bounded caches.
After those runs, only the monitoring psql connection remained open in the test
database. Workspace resolution was checked: each checkout loads its own pg-pool
and pg-protocol. Syntax, lint, TypeScript build, queue lifecycle and CLI same-checkout
guards passed. No driver source changed, so the earlier driver regression suite
was not repeated for this benchmark-only extension.

Use a disposable database; setup replaces `benchmark_autocommit_rows`. Install and
build both checkouts, then set PGHOST, PGPORT, PGUSER and PGDATABASE.

```bash
node benchmark/compare.js --base . --head . --profile autocommit-prepare --rounds 4 --duration 2 --warmup 0.5
node benchmark/compare.js --base . --head . --profile autocommit-pipeline --rounds 4 --duration 2 --warmup 0.5
node benchmark/compare.js --base ../node-postgres-upstream --head . --profile autocommit --rounds 4 --duration 1.5 --warmup 0.5
```

## Limits

These are warm-cache throughput tests on a shared four-core runner. No WAN/TLS
latency, proxy pooling, p95/p99 latency, application SQL mix or parameter skew was
measured. Bursts wait for all 16 requests before submitting the next burst; this
is not an open-loop arrival model. The preparation setting remains opt-in because
cached-plan and schema-change semantics still apply. Pipeline requires concurrent
queries on one checked-out Client; ordinary Pool.query leases do not overlap on
that connection. No runtime defaults were changed.
