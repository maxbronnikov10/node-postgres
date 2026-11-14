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
   Per-frame tests and real Client/Executor limit tests cover this stage. Many
   small rows can still make an unbounded eager Result: output row/byte budgets
   remain required before claiming bounded result handling.
4. Exercise an actual standby promotion and loss during writes. Measure recovery,
   verify durable markers and ensure assigned operations are not replayed.
   This evidence remains outstanding; the read-only fixture does not substitute.
5. Compare performance before/after reliability changes with equal frontend counts,
   validated results and duplicate same-code controls. Preserve negative and
   inconclusive results. Role probes are connection-time overhead, not free work.
6. Deliver a coherent, buildable public surface with documented limits, tests and
   reproducible measurements. Client/protocol/cursor releases must be coordinated;
   changing only the pg registry package would not be a valid release. Remote/npm
   publication requires the relevant access and is not claimed by local artifacts.

## Current stage

`321c5dc1` adds per-message bounds/EOF checks and endpoint selection/recovery.
`bd15d6bb` adds TLS endpoint validation and a before/after executor benchmark.
Remaining gates are result budgets, physical standby promotion, the final broader
recovery/performance audit and the refreshed delivery artifact. The goal remains
active while those are unproven. Additional speculative features are not gates.
