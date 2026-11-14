<!-- benchmark-comment -->

## Benchmark: `7aed08ba` against `2a5850fb`

Profile: queue.

| Scenario | Base operations/s | Head operations/s | Head / base | Rounds | Noise |
| --- | ---: | ---: | ---: | ---: | ---: |
| pool queue, depth 10, FIFO drain | 1019864 | 1137520 | 1.114x (+11.4%) | 1.06 to 1.15 | ±12.4% |
| pool queue, depth 10, timeout churn | 7575 | 7606 | 1.007x (+0.7%) | 0.96 to 1.01 | ±3.4% |
| pool queue, depth 1000, FIFO drain | 1139225 | 1388289 | 1.209x (+20.9%) | 1.19 to 1.35 | ±30.6% |
| pool queue, depth 1000, timeout churn :trophy: | 120097 | 131639 | 1.102x (**+10.2%**) | 1.02 to 1.14 | ±8.8% |
| pool queue, depth 10000, FIFO drain :trophy: | 993323 | 1173622 | 1.221x (**+22.1%**) | 1.12 to 1.25 | ±15.1% |
| pool queue, depth 10000, timeout churn :trophy: | 60234 | 101993 | 1.699x (**+69.9%**) | 1.47 to 1.79 | ±13.3% |

4 rounds of 1s per scenario, each round measuring base, head and a second process of each one after the other, in an order that changes every round. "Head / base" is the median of the per-round ratios and "Rounds" their range. "Noise" is how far base/base and head/head, the same code on both sides, got from 1 in this same run: that is what the machine did, so a row is marked only when the median moved further than that, at least 2%, and every round moved the same way: :eyes: slower, :trophy: faster. Only the ratio is comparable across runs, the absolute rates depend on the runner.

Node v22.22.1, AMD EPYC-Rome Processor, 4 cores.
