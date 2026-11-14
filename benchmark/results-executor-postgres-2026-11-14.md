<!-- benchmark-comment -->

## Benchmark: `0f5ba573` against `0f5ba573`

Profile: executor.
Endpoint: postgres-loopback (descriptive label).
Same checkout. Base: Pool.query, max 4. Head: QueryExecutor, max 4, depth 16, maxPending 1024. Both use pipeline true, maxAutoPrepare 16 and the same logged table; no BEGIN. Four frontend connections are prewarmed and every result is checked.

| Scenario | Base q/s | Head q/s | Head / base | Rounds | Noise |
| --- | ---: | ---: | ---: | ---: | ---: |
| independent SELECT, sequential | 3312 | 3092 | 1.027x (+2.7%) | 0.89 to 2.33 | ±84.1% |
| independent SELECT, 16 concurrent :trophy: | 6991 | 11557 | 1.454x (**+45.4%**) | 1.42 to 2.02 | ±31.6% |
| fresh SQL SELECT, 16 concurrent :trophy: | 6338 | 8507 | 1.346x (**+34.6%**) | 1.30 to 1.40 | ±12.0% |
| logged UPDATE, 16 concurrent | 2432 | 2886 | 1.182x (+18.2%) | 1.10 to 1.30 | ±22.5% |

4 rounds of 2s per scenario, each round measuring base, head and a second process of each one after the other, in an order that changes every round. "Head / base" is the median of the per-round ratios and "Rounds" their range. "Noise" is how far base/base and head/head, the same code on both sides, got from 1 in this same run: that is what the machine did, so a row is marked only when the median moved further than that, at least 2%, and every round moved the same way: :eyes: slower, :trophy: faster. Only the ratio is comparable across runs, the absolute rates depend on the runner.

Node v22.22.1, AMD EPYC-Rome Processor, 4 cores.
