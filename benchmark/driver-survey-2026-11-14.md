# Cross-language PostgreSQL driver survey, 2026-11-14

The largest remaining opportunities are a result path that preserves wire bytes,
bounded scheduling of independent queries, and explicit failure outcomes. Copying
every feature from another runtime would add cost without proving a benefit.
This survey compares mechanisms; it does not rank languages by benchmark speed.

Implemented on `perf/combined-optimizations`: a separate bounded QueryExecutor,
binary decoding from original wire bytes, validated text decoding, retained-buffer
protection, and a TLS certificate-identity fix. The comparison below separates
measured results from mechanisms still worth investigating.

## Sources and what transfers

Repositories were inspected at these revisions: pgJDBC `9c6eeaab40b4`, Npgsql
`ce8c83b32cc6`, rust-postgres `6c161e3226c0`, pgx `3843a26da3c4`, pg.zig
`3ccad62ab37a`, Vert.x SQL client `aa339326351d`. Live documentation was read on
2026-11-14; a source snapshot is not a claim that a release containing it is deployed.

| Runtime / driver | Mechanism supported by primary sources | Application to this fork |
| --- | --- | --- |
| Java / pgJDBC | Preparation threshold, adaptive fetch using a result byte budget, and configurable result-buffer limits. [Configuration](https://jdbc.postgresql.org/documentation/use/), [server preparation](https://jdbc.postgresql.org/documentation/server-prepare/). | Existing `maxAutoPrepare` caches immediately; a bounded reuse threshold could avoid caching one-off SQL. Cursor fetch should eventually budget bytes as well as rows. Both need workload measurements; no universal threshold is inferred. |
| Java / Vert.x | Distinct pooled-client and exclusive Pool APIs; the pooled client pipelines, with a configurable limit. Its ordinary Pool.query path is explicitly documented as not pipelined. [PostgreSQL client](https://vertx.io/docs/vertx-pg-client/java/#_pool_versus_pooled_client). | This informed the new opt-in QueryExecutor. Existing Pool.query/connect retain their exclusive-lease semantics; the new API has finite connection, in-flight and waiting limits. |
| C# / Npgsql | Batching, automatic preparation, sequential access for large fields, deferred connection reset, and role-aware multi-host connections. [Performance](https://www.npgsql.org/doc/performance.html), [failover](https://www.npgsql.org/doc/failover-and-load-balancing.html). | Batch/prepare/TLS grouping already exist here. Byte-budgeted reads, optional session reset, host role checks and failure isolation remain useful candidates. Session reset changes observable session state and prepared caches; it cannot be silently enabled. |
| Rust / tokio-postgres | Concurrently polled requests pipeline. Rows retain a DataRow body plus field ranges, and decode requested fields through FromSql. The inspected source validates row/metadata field-count agreement. [Pipelining](https://docs.rs/tokio-postgres/latest/tokio_postgres/#pipelining), [pinned Row source](https://github.com/rust-postgres/rust-postgres/blob/6c161e3226c0ca0f18f665610cbeb09862fe2f4b/tokio-postgres/src/row.rs). | Preserve bytes until the type is known. Implemented for binary/custom result paths; ordinary text retains a faster validated decoder. Full lazy Row objects would require a new API to preserve current eager object/array behavior and custom parser exceptions. |
| Zig / pg.zig | Typed access over raw column slices, optional duplication/arena ownership, per-connection statement caching, and a mapper caching name-to-index lookup. Slices normally expire on the next iteration. [Pinned README](https://github.com/karlseguin/pg.zig/blob/3ccad62ab37a26cae9fdddc1f6b73be8ee6cd234/readme.md). | Borrow the allocation discipline, not expiring-row semantics. JS callers retain rows after await, so parser buffer reuse must never overwrite an exposed view. Numeric precision and ownership must remain explicit. |
| Go / pgx | Binary/text codec selection, raw-value access, batching, pool lifetime jitter and liveness hooks. SafeToRetry means the error occurred before any request data was sent. [Rows](https://pkg.go.dev/github.com/jackc/pgx/v5#Rows), [pool configuration](https://pkg.go.dev/github.com/jackc/pgx/v5/pgxpool#Config), [retry classification](https://pkg.go.dev/github.com/jackc/pgx/v5/pgconn#SafeToRetry). | Add bounded admission, cancellable queueing, staggered connection recycling and explicit sent/outcome classification. Never infer safe replay from SQL looking like SELECT; functions and transaction state can have side effects. |

Npgsql's old multiplexing implementation is a warning, not a feature checklist.
It was removed from main on 2026-02-28 for the 11.0 milestone. The maintainer
described a central aggregation bottleneck on multicore machines and complicated
connection semantics. A Node implementation should use per-event-loop scheduling
and an explicit stateless API rather than copy that architecture.
[Removal discussion](https://github.com/npgsql/npgsql/issues/6449),
[removal commit](https://github.com/npgsql/npgsql/commit/2fea28143ae5bfae388f4ae722ea4ef08400ef6a).

## Current fork and concrete gaps

Already present: client pipelining, explicit batches, optional autoBatch, bounded
automatic prepared-statement cache, efficient pool waiters/handoff, write
backpressure, TLS record grouping and direct TLS negotiation. Their earlier
measurements are in [hardening](hardening-results-2026-11-13.md),
[autocommit](autocommit-results-2026-11-14.md) and [TLS](tls-results-2026-11-14.md).

Pool.query still acquires an exclusive lease; pipeline on a Pool does not combine
independent pool requests. Socket backpressure stops encoding, but does not bound
application-created Query objects or queued pool acquisitions. QueryExecutor now
provides a separate bounded route for explicitly independent statements. Existing
Pool and Client still require application admission control. Pool ownership is in
`packages/pg-pool/index.js`; query admission is in `packages/pg/lib/client.js`.

The result path had a reproducible correctness defect: DataRow decoded non-UTF8
bytes to text before choosing a binary type parser. A literal payload containing
00 ff 80 7f became replacement characters; a Buffer-preserving parser received
eight bytes instead of four. Array-mode binary number parsers also received text.
The candidate bypasses that lossy intermediate form. `pg-types` remains the codec
registry; it has no built-in binary bytea codec, so the bytea tests/benchmark
explicitly provide an identity codec on both arms. Unsupported codecs are not
silently described as newly implemented.

The same inspection exposed a separate retained-COPY-data defect: buffer
compaction overwrote previously returned slices. A regression reproduced a
retained byte changing from 255 to 73. Exposed raw/COPY backing storage is now
protected from later compaction. Ordinary text protocol parsing remains the
default of the public pg-protocol parse API; the driver uses its new raw adapter.

## Node.js mechanisms worth using

These are applicability judgments, not measured speedups unless marked implemented.

- Implemented: Buffer spans plus metadata-directed conversion, without eval,
  generated functions, a native addon or another dependency. Buffer.subarray shares
  storage, so ownership protection is part of the change. [Buffer documentation](https://nodejs.org/api/buffer.html#bufsubarraystart-end).
- Keep socket cork/writev and public TLS APIs; they are already used here. Reusing
  net.Socket onread storage could reduce receive allocations, but its buffer reuse
  conflicts with retained rows and it bypasses ordinary data events. It is a
  separate transport experiment, including TLS and worker compatibility, not a
  default switch. [Node 22 net.Socket](https://nodejs.org/docs/latest-v22.x/api/net.html#new-netsocketoptions).
- Use worker_threads only when profiles show CPU-heavy decoding worth transfer and
  scheduling costs. Prefer a connection owned by each worker over one central
  aggregator. Transferring pooled ArrayBuffers can clone more than a field and
  detaches owned storage; shared buffers require an ownership protocol.
  [Worker transfer rules](https://nodejs.org/api/worker_threads.html#considerations-when-transferring-typedarrays-and-buffers).
- AbortSignal can unify queue cancellation and deadlines; it cannot revoke a
  query already sent or prove that a COMMIT did not happen. diagnostics_channel
  can expose queue wait/send/receive/error stages with payload construction guarded
  by hasSubscribers. Neither parameter values nor SQL containing secrets belong in
  default telemetry. QueryExecutor implements cancellation with addAbortListener,
  whose Disposable removes the listener and whose handling resists another abort
  listener calling stopImmediatePropagation. The new constructor checks availability;
  existing Client/Pool imports retain their runtime requirements.
  [Abort listener API](https://nodejs.org/api/events.html#eventsaddabortlistenersignal-listener),
  [Diagnostics API](https://nodejs.org/api/diagnostics_channel.html).
- perf_hooks/CPU profiles should distinguish queue wait, event-loop delay,
  server time and result decoding before adding threads or tuning buffers. APIs
  new to Node 24/26 are candidates behind an engine decision; this prototype is
  built and measured on the installed Node 22.22.1.

## The larger change: bounded independent-query execution

Implemented in `8fb79c29`, exposed as `pg.QueryExecutor` and QueryExecutorError
from CommonJS and ESM. [Public API](../docs/pages/apis/query-executor.mdx).

The scheduler belongs to one event loop. It lazily opens at most four clients by
default, assigns at most 16 queries per client, and holds at most 1024 waiting
tasks. Each statement retains its own Sync/error boundary; autoBatch is disabled.
The scheduler does not encode waiting requests. Cancellation removes a queued
task in constant time, while a single monotonic deadline includes connection and
queue wait. The default deadline is 30 seconds; explicit zero disables it.

After assignment, timeout/abort discards the shared transport and can fail other
assigned queries. It cannot prove PostgreSQL stopped executing. Queued work is
not sent after its own cancellation; already assigned work is never replayed.
Errors distinguish not-sent, server-error and unknown outcomes, retaining the
original cause, including frozen errors. Only not-sent has safeToRetry true.

Connection creation has a short failure cooldown, not an endless retry timer.
Later submissions can reconnect. A terminated backend rejects assigned work as
unknown; work still unsent may execute once on a replacement. Graceful end drains
accepted work, and destroy also interrupts a connection already closing after end.
The latter had a reproduced hanging-shutdown defect and a red/green socket test.

This API requires independent statements; transaction/session workflows retain
exclusive Pool.connect. A non-idle transaction status poisons the executor client,
but SQL independence cannot be proven by a keyword regex. Multi-host role-aware
routing, connection jitter, server-side cancellation and new diagnostics channels
remain follow-up candidates. None is silently promised by this scheduler.

[Executor measurements and failure evidence](query-executor-results-2026-11-14.md)
cover equal frontend counts, sequential and concurrent SQL, verified TLS,
transaction-mode PgBouncer, fixed offered load and overload. Counts bound queued
tasks, not arbitrary caller payload bytes or total result memory. Heap observations
use fixed small parameters; they are not a universal hard-memory guarantee.

## Candidate verification and measurements

The first implementation, `3f747c3d`, passed functional checks but had a confirmed
wide-text regression: -5.8%, with all round ratios below 1 and a ±4.5% control band.
Other text medians were -8.9%, -8.9% and -3.1%; their control bands were wider.
[Exploratory raw-row results](results-raw-rows-initial-2026-11-14.md) are preserved.
The next revision, `5cce72dd`, removed a per-row Buffer view, but wide-text medians
remained negative. [Span-only results](results-raw-rows-span-2026-11-14.md) are kept.
The final `6bf1dec5` selects a validated text decoder for ordinary all-text Query
results and preserves raw spans for binary/custom queries and cursors. A custom
query describing several differently formatted portals before execution verifies
that mode selection cannot corrupt those results. Allocation reduction alone is
not treated as a speedup.

[Final text-path comparison](results-raw-rows-2026-11-14.md) and
[text versus binary](results-row-formats-2026-11-14.md) use the same fixed row
shapes and check every field. Final text medians are +4.5%, +8.0%, +8.5% and
+4.6%, all within their control bands; no text throughput win is established.
Final binary bytea is 2.360x (1.97–2.54x, controls ±27.0%), above controls.
Small binary numeric rows have a -22.6% median inside ±24.3% controls: no
general binary advantage is inferred. The exploratory result on `5cce72dd` was
2.229x for 16 x 16 KiB bytea, while small binary numeric rows were slower;
[those format results](results-row-formats-span-2026-11-14.md) are preserved.

Final source verification passed 947 enabled cases across pg, protocol, pool,
cursor, query-stream, native-specific and actual workerd tests. Pg's 116 unit/
integration files contributed 649 cases, including 27 executor cases and real
TLS handshakes. Other counts: 104 protocol, 93 pool, 43 cursor, 40 query-stream,
15 native-specific, three actual workerd. The pool has one pre-existing pending
case; optional SCRAM roles were not configured. Build, lint, ESM export/native
isolation and benchmark lifecycle/delay checks passed. Logs are retained outside
the repository under `/tmp/nodepg-survey-checks-20261114/final-*`.
[Validation summary](validation-disrupt-2026-11-14.json) is included in the branch.

The TLS follow-up `e7fbae09` preserves explicit ssl.servername, including an empty
string. Previously a DNS alias overwrote the intended certificate identity. Two
new real-handshake tests fail against the old condition and pass with trusted CA
and default hostname verification. Direct PostgreSQL and PgBouncer checks also
reject an incorrect hostname/untrusted CA; the executor's named statement remains
correct after PgBouncer replaces its backend. The warmed 16-query pipeline still
uses one client TLS application record, 1276 encrypted bytes in this fixture.

TLS session resumption was not added. PostgreSQL's default OpenSSL setup disables
both tickets and the server session cache; a client-side cache cannot enable an
unsupported server feature. Explicit context reuse and direct negotiation are
distinct existing controls. A terminating proxy may have a different policy;
there is no implicit cross-endpoint session cache in this patch.
[PostgreSQL TLS source](https://doxygen.postgresql.org/be-secure-openssl_8c_source.html).

All benchmark workers now assert that their pg-protocol and pg-pool resolve inside
the measured checkout. Sharing external dependencies through a node_modules
symlink must not accidentally load the other arm's changed workspace packages.

The new protocol export and its client/cursor consumers must be built and released
together. This is a local monorepo candidate, not an independently published pg
package compatible with an older pg-protocol. A registry release must first publish
and require a protocol version containing parseRaw. No registry publication is part
of this comparison.

No cross-language throughput ratio, WAN gain, production failover guarantee or
universal binary-mode speedup is claimed. Frame-size limits, incomplete-frame EOF
handling and full validation of other message kinds retain their existing limits.
Retained binary views can keep a larger backing allocation alive; callers needing
an independent small retained value can copy it explicitly.

## Other measured candidates to investigate

Prepared execution still sends a portal Describe in `Query.prepare` and in each
batch entry, even when the statement name is cached. Caching statement result
metadata/codec selection, as illustrated by Rust's Statement columns and pgx's
execution modes, could remove repeated descriptions. That requires DDL, renamed
columns, changed search_path, binary/text formats and per-query custom parsers to
be tested before enabling it. The current automatic cache also admits the first
N parameterized SQL texts rather than preferring frequently reused SQL; a bounded
reuse threshold is a separate candidate, not an unbounded frequency map.

pgx removes a released connection when it is busy or has a non-idle transaction
status. That is an appropriate invariant for the new independent-query executor;
changing existing Pool.release semantics requires a separate compatibility choice.
[Pinned pgx release path](https://github.com/jackc/pgx/blob/3843a26da3c4c50fc641493b8bb7fc96e810eb7a/pgxpool/conn.go).
Npgsql's read path attempts PostgreSQL cancellation within a deadline, then breaks
the connection when cancellation cannot be completed. The useful transfer is the
bounded synchronization/reuse contract, not treating an aborted JavaScript Promise
as proof that the database stopped executing.
[Pinned cancellation path](https://github.com/npgsql/npgsql/blob/ce8c83b32cc6df4da040c20f89e51931b307c54b/src/Npgsql/Internal/NpgsqlReadBuffer.cs).
