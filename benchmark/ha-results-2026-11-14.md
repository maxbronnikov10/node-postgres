# Endpoint recovery and protocol bounds, 2026-11-14

Runtime: `321c5dc1`; benchmark/check harness: `bd15d6bb`.
[Public contract](../docs/pages/apis/query-executor.mdx),
[verification data](validation-ha-2026-11-14.json),
[remaining goal gates](performance-reliability-goal-2026-11-14.md).

QueryExecutor now accepts up to 64 explicit endpoints and optional
targetSessionAttrs any/read-write/read-only. Connection-string defaults are parsed
before per-endpoint host/port/TLS overrides. Application statements are admitted
only after connection readiness and the optional transaction_read_only probe.
Each attempt has the configured connection deadline, including its role probe.
Role selection is a connection-time check, not continuous topology discovery.

Failure cooldown belongs to each endpoint. A sustained outage visits each endpoint
once before rejecting unsent work. A reproduced defect previously cycled between
slow blackholes forever when query deadlines were disabled; the bounded regression
failed before the generation guard and passed afterward. A later submission or
successful application progress permits recovery attempts. Assigned SQL is never
replayed, including an INSERT whose completion acknowledgement was lost.

Inbound frame lengths are checked against a validated cap, including split headers
before body-merge allocation. Clean EOF with a partial header/body raises
PG_PROTOCOL_ERROR and closes the driver transport. The new executor defaults to
16 MiB per message; ordinary Client preserves a configurable signed-Int32 limit.
Caps include the four-byte length and exclude the message tag. Coalesced valid
messages may exceed the cap in total. This is not a bound on eager Result memory.
The unpublished parseRaw helper now takes a named options object; its client and
protocol consumers must be released together.

## Evidence

997 reported cases passed: 677 pg cases in 118 files, 126 protocol, 93 pool,
43 cursor, 40 query-stream, 15 native-specific and three actual workerd cases.
One existing pool case remains pending; optional SCRAM roles were not configured.
Build/lint passed. Existing workerd checks exercise Client compatibility, not the
new executor's recovery implementation.

Fifteen real failover cases cover refused addresses, synchronous Client construction
failure, startup timeout, role mismatch, a withheld role-probe ReadyForQuery,
finite outage attempts with query_timeout zero, URI precedence, validation and
lost acknowledgement after commit. Durable non-unique markers remain exactly once.
Thirteen real message-limit cases cover typed errors, closed transports, drained
counts, accepted payloads and replacement connections. New framing tests first
failed against the old implementation. Existing SASL boundary regressions retain
their purpose using a complete following frame instead of an incomplete EOF tail.

The separate TLS endpoint check passed on PostgreSQL 18.7 with a temporary trusted
CA and TLS 1.3. An incorrect hostname is rejected before its INSERT; a correctly
verified default-read-only server is skipped; the writable endpoint receives one
marker. Client authorization and ALPN are checked. No certificate fallback or
implicit TLS downgrade was introduced. The read-only fixture is configured with
default_transaction_read_only=on; it is not a physical replica.

## Default-path performance

[Full before/after results](results-executor-ha-regression-2026-11-14.md) compare
the previous `c33d6cac` against `bd15d6bb`, using QueryExecutor on both arms:
four warmed connections, depth 16, pending 1024, preparation cache 16, target any,
identical validated SELECT/UPDATE workloads. No role probe runs for target any.
Four three-second rounds alternate two independent processes per implementation.
The same-code duplicate band measures run noise; it is not a confidence interval.

| Workload | Median ratio | Per-round range | Duplicate control band |
| --- | ---: | ---: | ---: |
| Sequential SELECT | 1.037x | 0.91–1.04x | ±14.5% |
| Concurrent SELECT | 0.952x | 0.93–1.07x | ±19.4% |
| Fresh concurrent SQL | 1.001x | 0.90–1.05x | ±24.3% |
| Logged concurrent UPDATE | 1.152x | 0.04–2.67x | ±2190.6% |

None establishes an improvement or regression. UPDATE is particularly unusable:
identical controls differed over twentyfold. A host PSI snapshot immediately after
the run reported full I/O pressure avg10 35.94% and full memory pressure avg10 3.61%.
This supports treating the run as noisy, not attributing a cause to a driver revision.
The fixture retained normal durability. No fsync/checkpoint setting was weakened
to improve the benchmark. A stable write-throughput rerun remains outstanding.

## Reproduce

Use disposable read-write and default-read-only PostgreSQL endpoints; never change
an application database to run these checks.

```bash
corepack yarn build
node_modules/.bin/mocha packages/pg-protocol/dist/**/*.test.js --reporter dot
node packages/pg/test/integration/client/query-executor-failover-tests.js
node packages/pg/test/integration/client/protocol-limits-tests.js
PG_HA_RO_PORT=32775 PG_HA_TLS_CA=/path/to/fixture-ca.crt node benchmark/ha-tls-check.js
node benchmark/compare.js --base /path/to/c33d6cac --head . --profile executor-regression --rounds 4 --duration 3 --warmup 0.5
```

Set the normal PGHOST/PGPORT/PGUSER/PGDATABASE variables. The focused failover test
uses the disposable nodepg_ha fixture and ports 32774/32775. No production failover
or arbitrary result-memory guarantee is claimed. Output budgets, physical standby
promotion and the final delivery/performance audit remain open; the goal is active.
