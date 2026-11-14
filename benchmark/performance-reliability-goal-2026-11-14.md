# Performance, reliability and recovery target

User scope: redesign interfaces and internals freely, including a new-library
shape, with performance, reliability and fault tolerance as the priorities.
Preserving an old interface is not a reason to retain an inefficient or unsafe
execution model. A new package name alone is not a performance improvement.

The chosen core is a bounded independent-query engine: finite connection and
request budgets, preserved wire bytes, explicit outcomes and no automatic replay
of assigned SQL. Exclusive session/transaction work uses a separate ownership path.

## Completion evidence required

1. Correct bytes and ordering, per-statement error isolation, bounded admission,
   cancellation/deadlines, drain/destroy and unknown write outcomes. Existing
   executor tests and measured same-connection-count comparisons establish these
   behaviors; new changes must keep their regressions passing.
2. Fail over before application dispatch, select writable/read-only endpoints,
   bound connection attempts during a sustained outage, and preserve per-endpoint
   TLS verification. Real endpoint/role/TLS tests cover the current implementation.
   A default-read-only server is not evidence of physical replication promotion.
3. Reject oversized/truncated protocol frames before unbounded accumulation.
   Per-frame tests and real Client/Executor limit tests cover this stage. Aggregate
   unfinished-result row/wire-byte budgets now cover accumulation across frames and
   physical connections, with 41 behavioral regressions. Completed caller-held
   Results, parameters and custom parser allocations are outside those budgets;
   wire-byte accounting is not a JavaScript heap limit.
4. Exercise an actual standby promotion and loss during writes. Measure recovery,
   verify durable markers and ensure assigned operations are not replayed.
   Two real physical-standby experiments now pass, including primary SIGKILL,
   manual promotion and fresh work through the same executor. Seed WAL is explicitly
   replayed first; these experiments do not establish automatic election or zero RPO.
   See [external results and physical evidence](github-results-2026-11-14.md).
5. Compare performance before/after reliability changes with equal frontend counts,
   validated results and duplicate same-code controls. Preserve negative and
   inconclusive results. Role probes are connection-time overhead, not free work.
6. Deliver a coherent, buildable public surface with documented limits, tests and
   reproducible measurements. Client/protocol/cursor releases must be coordinated;
   changing only the pg registry package would not be a valid release. Eight
   experimental package archives now have exact internal version pins and identical
   hashes across two builds. A fresh consumer passes CJS/ESM, executor, binary,
   cursor and stream checks; optional native installs/builds and queries separately.
   Source and archives are in the user's GitHub fork; no npm registry publication
   is claimed.

## Current stage

GitHub runtime `fdba8c23136b` (local source `f7012989a2a2`, identical tree
`949c25bace8cdb54e6aadef02cb82b66b1fa49b5`) includes framing, endpoint recovery,
TLS checks and aggregate result budgets. Physical standby promotion has two
passing reproductions. The dedicated regression run passes 1038 cases; ordinary
CI passes all 11 Node/PostgreSQL combinations and lint, including its HA/SCRAM
fixtures. QueryExecutor requires `events.addAbortListener`; ordinary Client/Pool
continue to work on Node 16. Eight coordinated archives and an isolated consumer
are verified on GitHub.

[The second external report](github-results-budgets-2026-11-14.md) retains both the
initial performance regression and the direct follow-up. PgBouncer comparisons
use equal frontend counts, verified TLS and same-code controls. Result budgets
have a measured bulk-result cost; the context change and large TLS parameters do
not have a confirmed QPS gain. All three replacement-stage VM measurements pass; the one startup port collision
is recorded and its data-free job was retried alone. All six evidence gates are
covered within the documented runtime and workload limits.
Additional speculative features are not gates.
