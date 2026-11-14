# TLS and transaction-pooling improvements, 2026-11-14

Branch: `perf/combined-optimizations`. Final implementation revision: `55bc7ad0`;
workload definitions: `3519fe3d`.
Before-change driver: `b54455de`. Results use JavaScript pg, Node v22.22.1, and the
same shared four-core AMD EPYC-Rome runner as the earlier comparisons.

A warmed 16-query pipeline burst used one client TLS application record instead
of two on both endpoints. Final steady-state throughput differences remained
inside the measured control bands. Explicit secureContext reuse increased direct
PostgreSQL connection-cycle throughput by 16.3%, above its 12.5% control band.
Large bytea requests through PgBouncer had negative medians in both runs; their
noise bands were wider, so this remains a workload to verify on a dedicated host.

## Implemented

Encrypted Node.js pipeline writes are corked until the next Node.js tick, so
several synchronous query submissions can share a TLS record. Each query still
has its own Sync and error boundary. A full writable buffer is flushed immediately,
then backpressure pauses encoding after a complete query. A regression test first
reproduced 16,403 bytes unnecessarily waiting in a flowing stream and passed after
the early-flush fix. The one-shot flush also prevents a stale next-tick callback
from uncorking a newer batch. Ordinary unencrypted streams and streams without cork
support retain their existing paths. No enable/disable flag was added.

TLS contexts are not cached implicitly. The API docs show explicit reuse of
`ssl.secureContext`, keeping CA/key/certificate/version ownership with the caller.
Direct TLS negotiation already existed; it was documented and benchmarked rather
than presented as a new driver feature. Neither certificate validation nor cipher
defaults were weakened.

The autocommit benchmark now checks the bounded **frontend** preparation cache.
Its old server query for `pg_auto_%` names was invalid for a transaction pooler:
PgBouncer rewrites names, changes assigned backends and shares backend caches.
Actual proxy configuration, backend replacement and server TLS are checked separately.

## Fixture and controls

Temporary PostgreSQL 18.7 (`postgres:18-alpine`) and Alpine-packaged PgBouncer
1.25.2, isolated from application databases. The proxy was installed only inside
the removable test container. Host packages and application configuration were
not changed. Both services were exposed only through loopback-published ports.

- A temporary CA signed a server certificate for localhost and 127.0.0.1.
- Node required that CA, verified the hostname, and asserted `authorized === true`.
- The measured profiles fixed TLS 1.3 and checked direct-mode ALPN `postgresql`.
- PgBouncer used transaction pooling, pool size 4, max_prepared_statements 200,
  client TLS required, and backend TLS `verify-full` with the test CA.
- Backend TLS was confirmed through SHOW SERVERS, including the negotiated TLS
  1.3 cipher. Authentication was trust in the private fixture, isolating TLS costs
  from password/SCRAM authentication costs.
- PostgreSQL fsync, synchronous_commit and full_page_writes remained enabled.

Every comparison alternates four persistent actors, two per arm. Only one actor
is measured at a time; the duplicate same-code actors estimate control noise.
Unless stated otherwise, scenarios have four two-second rounds and a 0.5-second
warmup per actor. A result is marked only when its median exceeds both 2% and the
observed control band and every round moves in the same direction. This is not
a confidence interval; the runner is shared and some scenarios remain noisy.

## Encrypted record volume

A transparent loopback TCP relay parsed TLS record headers without decrypting or
recording plaintext/keys. After connection/preparation warmup, it observed a burst
of 16 parameterized SELECTs on one pipeline client. Both versions returned the
literal ordered values 0 through 15.

| Endpoint | Before: client application records / encrypted bytes | After |
| --- | ---: | ---: |
| Direct PostgreSQL | 2 / 1298 | 1 / 1276 |
| PgBouncer transaction pooling | 2 / 1298 | 1 / 1276 |

This measures client-to-server TLS records and their ciphertext framing, not
TCP packet counts or total bidirectional traffic. It does not imply a 50% CPU or
latency improvement. The 22-byte difference is the eliminated record overhead
for this TLS 1.3 fixture.

## Steady-state PostgreSQL

[Full PostgreSQL TLS results](results-tls-steady-postgres-2026-11-14.md).
Both arms use pipeline true, maxAutoPrepare 16, the same explicit shared TLS
context and direct negotiation. The comparison changes the driver revision.
Connections are persistent, so these rows exclude connection establishment.

| Workload | Change | Per-round ratio | Control noise | Interpretation |
| --- | ---: | ---: | ---: | --- |
| Parameterized SELECT, 16 concurrent | +4.9% | 0.85–1.53 | ±43.2% | Inconclusive |
| Fresh SQL SELECT, 16 concurrent | +8.5% | 1.07–1.35 | ±33.8% | Inconclusive |
| Simple SELECT 1, 16 concurrent | +18.0% | 1.16–1.25 | ±23.6% | Inconclusive |
| Two concurrent 1 MiB bytea parameters | +4.1% | 0.95–1.09 | ±10.6% | Inconclusive |

All final direct-PostgreSQL medians increased, but none exceeded the control band.
This run does not establish a throughput win. The earlier candidate runs are kept
as [PostgreSQL initial results](results-tls-steady-postgres-initial-2026-11-14.md)
and [PgBouncer initial results](results-tls-steady-pgbouncer-initial-2026-11-14.md).
Those used `3519fe3d`, before the full-buffer fix, and are exploratory rather than
the final implementation's benchmark. In particular, the initial PgBouncer bytea
median was -5.9% inside ±11.7% controls; that prompted the full-buffer investigation,
but did not establish a performance regression.

## Steady-state transaction-mode PgBouncer

[Full transaction-mode PgBouncer results](results-tls-steady-pgbouncer-2026-11-14.md),
with identical before/after options to the PostgreSQL comparison above.

| Workload | Change | Per-round ratio | Control noise | Interpretation |
| --- | ---: | ---: | ---: | --- |
| Parameterized SELECT, 16 concurrent | +7.2% | 1.03–1.11 | ±29.2% | Inconclusive |
| Fresh SQL SELECT, 16 concurrent | +11.8% | 1.06–1.42 | ±53.8% | Inconclusive |
| Simple SELECT 1, 16 concurrent | +12.4% | 0.89–1.29 | ±34.1% | Inconclusive |
| Two concurrent 1 MiB bytea parameters | -9.0% | 0.85–0.97 | ±22.6% | Inconclusive; watch large payloads |

No final PgBouncer row exceeds its control band. The large-payload median is
negative in both exploratory and final runs, so this workload should be checked
on a dedicated runner before claiming the optimization is neutral there.

## Connection cycles and autocommit

The connection-cycle profiles isolate existing options within the same checkout:
[PostgreSQL](results-tls-handshake-postgres-2026-11-14.md) and
[PgBouncer](results-tls-handshake-pgbouncer-2026-11-14.md). One operation includes
connect, one SELECT and close. These rates are **completed connections/s**, not
pure TLS handshake latency. Fresh vs shared context keeps postgres negotiation
on both sides; postgres vs direct negotiation keeps a shared context on both.

| Endpoint and change | Completed connections/s change | Per-round ratio | Control noise | Interpretation |
| --- | ---: | ---: | ---: | --- |
| PostgreSQL: fresh → shared context | +16.3% | 1.02–1.19 | ±12.5% | Exceeds control band |
| PostgreSQL: postgres → direct negotiation | +4.7% | 1.00–1.24 | ±24.7% | Inconclusive |
| PgBouncer: fresh → shared context | +13.6% | 1.04–1.39 | ±16.1% | Inconclusive |
| PgBouncer: postgres → direct negotiation | +8.9% | 0.96–1.20 | ±12.5% | Inconclusive |

Explicit context reuse showed the clearest measured connection-cycle gain. This
is an existing API option, not automatic cross-client caching introduced by the
patch. The direct-negotiation rows did not establish an improvement on loopback;
no WAN latency reduction is claimed from these measurements.

The [autocommit preparation comparison through PgBouncer](results-tls-autocommit-prepare-pgbouncer-2026-11-14.md)
uses the corrected frontend-cache validation and compares maxAutoPrepare 0 versus
16, with pipeline disabled. It includes real logged-table SELECT and UPDATE;
these six cases use four 1.5-second rounds and a 0.5-second warmup per actor.

| Workload | Change | Per-round ratio | Control noise | Interpretation |
| --- | ---: | ---: | ---: | --- |
| Client SELECT, sequential | +15.0% | 1.02–1.28 | ±27.7% | Inconclusive |
| Pool SELECT, sequential | +9.2% | 0.99–1.26 | ±21.4% | Inconclusive |
| Pool SELECT, 16 concurrent | +7.3% | 0.89–1.19 | ±34.9% | Inconclusive |
| Pool fresh SQL SELECT, 16 concurrent | -1.3% | 0.96–1.05 | ±26.7% | Inconclusive |
| Client UPDATE, sequential | +1.1% | 0.97–1.09 | ±12.4% | Inconclusive |
| Pool UPDATE, 16 concurrent | -1.2% | 0.95–1.32 | ±26.1% | Inconclusive |

These simple autocommit queries do not establish a preparation-cache throughput
benefit through this pooler. The correctness checks passed, including bounded
frontend cache size and named-query recovery after backend replacement. Keep
pool sizing, prepared tracking and real SQL costs in the application-specific
comparison; this fixture does not justify enabling a setting universally.

## Regression and compatibility checks

- The earlier TLS revision passed 309 pg unit cases and 292 enabled pg integration
  cases. Optional SCRAM roles were not configured. These historical counts are
  superseded for the combined branch by the
  [executor/TLS follow-up verification](query-executor-results-2026-11-14.md),
  including its real TLS unit/integration checks.
- Eleven pipeline tests cover TCP/TLS-model FIFO, drain, queued timeouts, transport
  failure, frozen encoder errors, balanced corking and prompt full-buffer sending.
  These are part of the
  unit count above.
- Actual TLS 1.3 checks passed for before/after drivers, directly and through
  PgBouncer: trusted CA, hostname, ordered results and per-query error isolation.
  An untrusted CA and an incorrect hostname were both rejected.
- PgBouncer tests verified a cached named query still returns the correct value
  after RECONNECT replaces the backend PID; SHOW CONFIG/SERVERS/STATS confirmed
  preparation tracking and verified backend TLS.
- A direct TLS 1.2 pipeline with certificate verification returned ordered results.
- Three actual Cloudflare Worker runtime tests passed. The Node-only grouping
  does not require Node TLS APIs on the worker path.
- Build, lint, benchmark CLI/lifecycle self-checks, and every new profile's
  smoke/result/cache/TLS assertions passed.

## Reproduce

Install/build both checkouts. Use a disposable TLS-enabled PostgreSQL and optionally
PgBouncer 1.25+ with protocol-level preparation enabled. Set normal PGHOST/PGPORT/
PGUSER/PGDATABASE plus PG_BENCH_TLS_CA to the CA PEM path. The endpoint label is
descriptive only. The fixture-specific tls-check also needs `untrusted.crt` beside
the CA and, for PgBouncer, a disposable `nodepg_tls` database and admin access.
That check issues RECONNECT for the fixture database; do not use it on production.

```bash
node benchmark/tls-check.js ../node-postgres-before-tls
node benchmark/tls-check.js .
node benchmark/compare.js --base ../node-postgres-before-tls --head . --profile tls-steady --rounds 4 --duration 2 --warmup 0.5
node benchmark/compare.js --base . --head . --profile tls-handshake --rounds 4 --duration 2 --warmup 0.5
```

## Limits

No WAN/packet-loss, production query mix, TLS client-certificate authentication,
SCRAM cost, native libpq TLS performance or long-running certificate-rotation load
was measured. PgBouncer results apply to the tested 1.25.2 fixture/configuration.
Session resumption was not implemented; explicit context reuse is a separate
operation. No production TLS or pool settings were changed.

## Follow-up

`e7fbae09` preserves explicit ssl.servername and empty SNI instead of overwriting
them with the DNS connection host. Real trusted-CA handshakes reproduce and cover
both behaviors. The [delayed TLS connection-cycle comparison](results-tls-handshake-delay-2026-11-14.md)
finds direct negotiation +20.6% (1.19–1.24x, controls ±2.6%) through an opaque
3 ms-per-direction relay. Context reuse is inconclusive in that delayed case.
These are existing options measured under modeled propagation delay; no real WAN
or universal TLS-throughput gain is inferred. See the
[full follow-up](query-executor-results-2026-11-14.md) for bounded independent-query
execution through verified TLS and transaction-mode PgBouncer.
