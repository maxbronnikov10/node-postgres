<!-- benchmark-comment -->

## Benchmark: `0f5ba573` against `0f5ba573`

Profile: executor.
Endpoint: postgres-tls-delay3ms-per-direction (descriptive label).
Same checkout. Base: Pool.query, max 4. Head: QueryExecutor, max 4, depth 16, maxPending 1024. Both use pipeline true, maxAutoPrepare 16 and the same logged table; no BEGIN. Four frontend connections are prewarmed and every result is checked.
Verified TLS 1.3, shared context on both arms.
Opaque TCP relay delays application bytes by 3 ms per direction; excludes TCP handshake, bandwidth limits and packet loss.

| Scenario | Base q/s | Head q/s | Head / base | Rounds | Noise |
| --- | ---: | ---: | ---: | ---: | ---: |
| independent SELECT, sequential | 120 | 126 | 1.033x (+3.3%) | 0.99 to 1.08 | ±7.9% |
| independent SELECT, 16 concurrent :trophy: | 451 | 1708 | 3.742x (**+274.2%**) | 3.57 to 4.04 | ±11.5% |
| fresh SQL SELECT, 16 concurrent :trophy: | 458 | 1611 | 3.500x (**+250.0%**) | 3.28 to 3.68 | ±4.3% |
| logged UPDATE, 16 concurrent :trophy: | 373 | 991 | 2.693x (**+169.3%**) | 2.52 to 3.03 | ±12.0% |

4 rounds of 2s per scenario, each round measuring base, head and a second process of each one after the other, in an order that changes every round. "Head / base" is the median of the per-round ratios and "Rounds" their range. "Noise" is how far base/base and head/head, the same code on both sides, got from 1 in this same run: that is what the machine did, so a row is marked only when the median moved further than that, at least 2%, and every round moved the same way: :eyes: slower, :trophy: faster. Only the ratio is comparable across runs, the absolute rates depend on the runner.

Node v22.22.1, AMD EPYC-Rome Processor, 4 cores.
