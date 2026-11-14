<!-- benchmark-comment -->

## Benchmark: `eb4e4dc9` against `eb4e4dc9`

Profile: executor.
Endpoint: pgbouncer-transaction-tls (descriptive label).
Same checkout. Base: Pool.query, max 4. Head: QueryExecutor, max 4, depth 16, maxPending 1024. Both use pipeline true, maxAutoPrepare 16 and the same logged table; no BEGIN. Four frontend connections are prewarmed and every result is checked.
Verified TLS 1.3, shared context on both arms.

| Scenario | Base q/s | Head q/s | Head / base | Rounds | Noise |
| --- | ---: | ---: | ---: | ---: | ---: |
| independent SELECT, sequential | 2585 | 2652 | 1.062x (+6.2%) | 0.87 to 1.17 | ±13.6% |
| independent SELECT, 16 concurrent | 5774 | 8944 | 1.477x (+47.7%) | 1.19 to 2.30 | ±64.5% |
| fresh SQL SELECT, 16 concurrent :trophy: | 5585 | 8030 | 1.434x (**+43.4%**) | 1.37 to 1.45 | ±32.2% |
| logged UPDATE, 16 concurrent | 2222 | 2417 | 1.094x (+9.4%) | 1.05 to 1.13 | ±25.1% |

4 rounds of 2s per scenario, each round measuring base, head and a second process of each one after the other, in an order that changes every round. "Head / base" is the median of the per-round ratios and "Rounds" their range. "Noise" is how far base/base and head/head, the same code on both sides, got from 1 in this same run: that is what the machine did, so a row is marked only when the median moved further than that, at least 2%, and every round moved the same way: :eyes: slower, :trophy: faster. Only the ratio is comparable across runs, the absolute rates depend on the runner.

Node v22.22.1, AMD EPYC-Rome Processor, 4 cores.
