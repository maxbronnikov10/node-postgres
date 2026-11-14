<!-- benchmark-comment -->

## Benchmark: `bd15d6bb` against `c33d6cac`

Profile: executor-regression.
Endpoint: postgres-ha-regression (descriptive label).
Before/after QueryExecutor on both arms: max 4, depth 16, maxPending 1024, maxAutoPrepare 16, target any. Four warmed frontends, checked results, no BEGIN. Actors run sequentially and update identical fixed keys.

| Scenario | Base q/s | Head q/s | Head / base | Rounds | Noise |
| --- | ---: | ---: | ---: | ---: | ---: |
| independent SELECT, sequential | 3332 | 3447 | 1.037x (+3.7%) | 0.91 to 1.04 | ±14.5% |
| independent SELECT, 16 concurrent | 10126 | 9961 | 0.952x (-4.8%) | 0.93 to 1.07 | ±19.4% |
| fresh SQL SELECT, 16 concurrent | 7732 | 7361 | 1.001x (+0.1%) | 0.90 to 1.05 | ±24.3% |
| logged UPDATE, 16 concurrent | 1816 | 2101 | 1.152x (+15.2%) | 0.04 to 2.67 | ±2190.6% |

4 rounds of 3s per scenario, each round measuring base, head and a second process of each one after the other, in an order that changes every round. "Head / base" is the median of the per-round ratios and "Rounds" their range. "Noise" is how far base/base and head/head, the same code on both sides, got from 1 in this same run: that is what the machine did, so a row is marked only when the median moved further than that, at least 2%, and every round moved the same way: :eyes: slower, :trophy: faster. Only the ratio is comparable across runs, the absolute rates depend on the runner.

Node v22.22.1, AMD EPYC-Rome Processor, 4 cores.
