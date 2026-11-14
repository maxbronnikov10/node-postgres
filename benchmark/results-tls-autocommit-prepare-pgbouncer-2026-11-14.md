<!-- benchmark-comment -->

## Benchmark: `55bc7ad0` against `55bc7ad0`

Profile: autocommit-prepare.
Endpoint: pgbouncer-transaction (descriptive label).
Same checkout. Base: maxAutoPrepare 0. Head: maxAutoPrepare 16. Pipeline disabled; no BEGIN. Pool max: 4; concurrency: 16.

| Scenario | Base q/s | Head q/s | Head / base | Rounds | Noise |
| --- | ---: | ---: | ---: | ---: | ---: |
| autocommit, client SELECT, sequential | 2080 | 2339 | 1.150x (+15.0%) | 1.02 to 1.28 | ±27.7% |
| autocommit, pool SELECT, sequential | 1919 | 2095 | 1.092x (+9.2%) | 0.99 to 1.26 | ±21.4% |
| autocommit, pool SELECT, concurrent x16 | 4849 | 5356 | 1.073x (+7.3%) | 0.89 to 1.19 | ±34.9% |
| autocommit, pool SELECT, fresh SQL, concurrent x16 | 4573 | 4488 | 0.987x (-1.3%) | 0.96 to 1.05 | ±26.7% |
| autocommit, client UPDATE, sequential | 701 | 721 | 1.011x (+1.1%) | 0.97 to 1.09 | ±12.4% |
| autocommit, pool UPDATE, concurrent x16 | 2005 | 2133 | 0.988x (-1.2%) | 0.95 to 1.32 | ±26.1% |

4 rounds of 1.5s per scenario, each round measuring base, head and a second process of each one after the other, in an order that changes every round. "Head / base" is the median of the per-round ratios and "Rounds" their range. "Noise" is how far base/base and head/head, the same code on both sides, got from 1 in this same run: that is what the machine did, so a row is marked only when the median moved further than that, at least 2%, and every round moved the same way: :eyes: slower, :trophy: faster. Only the ratio is comparable across runs, the absolute rates depend on the runner.

Node v22.22.1, AMD EPYC-Rome Processor, 4 cores.
