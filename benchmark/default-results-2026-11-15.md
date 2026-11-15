# Automatic SQL throughput, 2026-11-15

Source: `efbc5432bac021deed99e901dc1c414893ff0f4b`; tree: `f8c41c63fc270ca36c4d8cdf20f7d17ba1d1c2c2`.

These changes run automatically through `postgres(url)` and ordinary tagged queries. No parameter type hints, custom parsers, `.values()`, binary mode, or new tuning flags are required for the object-row path. Array rows are measured separately with `.values()` on both clients.

The new default client is faster than its previous version on two qualified before/after point-query trials (+3.66–4.29%). Ordinary SELECTs still do not beat Postgres.js 4.1.1. The confirmed default throughput win is 1 MiB bytea input.

## What changed

- Frozen template literals reuse bounded, expiring compiled SQL; scalar arguments avoid intermediate fragment wrappers.
- Prepared statements reuse immutable row layouts while each result keeps independent mutable metadata. Current parser identities are checked before reuse.
- Executor-owned queries can consume validated DataRow buffers directly. Public message observers, explicit per-query parsers, binary results and unsupported layouts retain the existing path.
- Generated readers materialize text and mixed rows directly. Native UTF-8 decoding and short canonical int4 decoding avoid intermediate work; int8 stays an exact string. Negative, unusual and full-range int4 values retain the checked fallback.
- Small cached statements send Bind, Execute and Sync in one write. Large arguments avoid an extra payload copy. Every independent statement still has its own Sync and commit boundary.
- A shared executor timer tracks deadlines, and fixed query/task shapes reduce normalization and queue overhead. Queue, row, byte and protocol limits remain enforced.

Generated readers are bounded to 32 fields; the shared reader cache holds at most 128 entries with a five-minute TTL. Unsupported code generation falls back to ordinary parsing. Cold layouts have compilation cost; the benchmarks warm stable query shapes. Isolated int4 microbenchmarks found some negative/full-range fallback cases up to 12% slower after short-value specialization; end-to-end claims below are limited to the measured workloads.

## Controlled throughput measurements

[GitHub Actions run](https://github.com/maxbronnikov10/node-postgres/actions/runs/43715536595). Six independent Ubuntu 24.04 VMs: three TCP trials and three verified TLS 1.3 trials with a relay delaying each direction by 3 ms. Node.js 22.22.1, PostgreSQL 18.7, pinned Postgres.js 4.1.1. PostgreSQL image: `postgres@sha256:1018733457011bf88d81db98cf43aac6d5150afc18787dbe204771fedf80ff95`.

Both APIs use four connections, depth 16 and automatic preparation. No explicit parameter type hints are supplied. Four separate actors (two copies per implementation), eight three-second rounds and two-second warmup use rotating balanced order. Ratios are medians of paired per-round ratios. Same-code controls measure drift. A claim requires control noise at most 10%, an effect above both noise and 2%, and all paired rounds in the same direction. Noisy or inconclusive cells are retained and marked.

Ratio = pg.postgres / Postgres.js; above 1 favors pg.postgres. `†` means the cell fails the stated quality/effect rule.

| Workload | TCP 1 | TCP 2 | TCP 3 | TLS 1 | TLS 2 | TLS 3 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Point SELECT, sequential | 0.920× | 0.887× | 0.911×† | 1.018×† | 0.999×† | 1.000×† |
| Point SELECT, concurrent ×16 | 0.787× | 0.896× | 0.773× | 0.988×† | 0.986×† | 0.981×† |
| 500 rows, objects | 0.823× | 0.861× | 0.792× | 0.965× | 0.966× | 0.964× |
| 500 rows, arrays | 0.829× | 0.889× | 0.793× | 0.976× | 0.976×† | 0.966× |
| 500 mixed rows | 0.789× | 0.840× | 0.788× | 0.922× | 0.916× | 0.917× |
| 1 MiB bytea input | 3.299× | 3.176×† | 3.301× | 1.877× | 1.909× | 1.948× |
| Durable UPDATE, concurrent ×16 | 0.888× | 0.933× | 0.903× | 0.991×† | 0.988×† | 0.976×† |

Each VM exposes four vCPUs. TCP trials 1/3 and TLS trials 1/2 use Intel Xeon 6975P-C; TCP trial 2 and TLS trial 3 use AMD EPYC 7763. Ratios compare implementations inside each VM; absolute throughput is not pooled across CPU models.

The repeatable default win is the 1 MiB bytea input: 1.877–1.948× over verified TLS on all three trials. TCP trials 1/3 show 3.299–3.301×; TCP trial 2 has 12.4% control noise and is excluded from a confirmed-win claim. Ordinary TCP SELECT workloads remain slower; small TLS SELECT differences are inconclusive, and mixed-row TLS SELECT remains slower.

Raw SHA-256-verified workflow archives and [calculated summary](default-results-2026-11-15/summary.json) are preserved in [the results directory](default-results-2026-11-15/). [Artifact manifest](default-results-2026-11-15/artifacts.json) records original IDs and digests.

The before/after test compares this implementation with `2db1b547902483602ded74f58c2477253bf30b4b` on the same VM. Its existing harness profile is named `sql-compile`, but it measures complete tagged database operations, including execution and decoding.

| TCP VM | Before ops/s | After ops/s | Ratio | Control noise | Qualified |
| --- | ---: | ---: | ---: | ---: | --- |
| 1 | 41326 | 42850 | 1.037× | 2.40% | yes |
| 2 | 15447 | 15894 | 1.024× | 2.66% | no |
| 3 | 41641 | 43552 | 1.043× | 2.47% | yes |

The change improves this point-query workload by 3.66–4.29% on two qualified VMs. The third shows +2.42%, below its 2.66% control noise. This is an improvement over the previous default client, not evidence that ordinary SELECTs beat Postgres.js.

## Reliability checks

[CI run](https://github.com/maxbronnikov10/node-postgres/actions/runs/43715536553): all ten jobs passed, including lint and nine Node.js/PostgreSQL combinations (Node 20/22/24 with PG18, Node26 with PG13–18). Node22/PG18 executed 1,173 checks: 1,134 checkmarked checks plus TAP suites of 13 and 26. Tests cover framing, malformed lengths, parser failures, result budgets, observer compatibility, cached-layout isolation, deadlines, independent commits and transaction rollback.

Six ten-minute durable synthetic OLTP-like runs, 100,000 fixture rows, 1,500 offered operations/s per VM. Mix: 70% point reads, 20% range reads, 8% writes, 2% two-write transactions. Durability (`fsync`, `full_page_writes`, `synchronous_commit`) remained on. All results and committed counter totals were checked.

| VM | Completed | Failures / queue rejects | p95 ms | p99 ms | Verified increments |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1-tcp | 900,000 | 0 / 0 | 1.438 | 1.759 | 108,000 |
| 1-tls | 900,000 | 0 / 0 | 10.847 | 41.599 | 108,000 |
| 2-tcp | 900,000 | 0 / 0 | 1.695 | 2.143 | 108,000 |
| 2-tls | 900,000 | 0 / 0 | 10.967 | 41.951 | 108,000 |
| 3-tcp | 900,000 | 0 / 0 | 1.418 | 1.750 | 108,000 |
| 3-tls | 900,000 | 0 / 0 | 12.007 | 48.959 | 108,000 |

Total: **5,400,000 completed operations, zero workload failures or scheduler rejections, 648,000 verified counter increments**. A separate deliberate 512-request overload per VM rejected 192 requests before sending and recovered; those are not workload failures.

Additional disposable local PgBouncer 1.25.2 check: transaction pooling, four backends, prepared-statement tracking disabled, TLS 1.3 with CA verification on both legs, relay delay 3 ms per direction, preparation disabled, no type hints. Each client completed 180,000 offered operations over 120 seconds at 1,500 operations/s, with zero failures or scheduler rejections. Each persisted exactly 21,600 expected counter increments. This is a compatibility/reliability check; a single local run does not establish a comparative speed advantage.

The separate deliberate executor overload offered 512 requests, rejected 192 before sending, and recovered. Those expected admission rejections are separate from the measured workload. Mixed prepared object/array queries also passed with `--disallow-code-generation-from-strings`.

An isolated application installed all four built tarballs (`pg`, `pg-protocol`, `pg-pool`, `pg-connection-string`) without workspace links. Mixed object/array rows, exact int8 strings, independent commits around a failed statement and transaction rollback passed.

## Scope of the evidence

These are reproducible synthetic workloads, not a capture of an application production workload or a guarantee of production capacity. A fixed offered-rate soak establishes correctness at that rate, not maximum throughput. Local microbenchmarks and CPU profiles guided implementation; they are not used to claim SQL throughput wins. Raw local CPU profiles remain private.
