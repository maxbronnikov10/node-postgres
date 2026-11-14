<!-- benchmark-comment -->

## Benchmark: `80eb86b4` against `2a5850fb`

Profile: autocommit.
Default options on both checkouts; independent queries without BEGIN. Pool max: 4; concurrency: 16.

| Scenario | Base q/s | Head q/s | Head / base | Rounds | Noise |
| --- | ---: | ---: | ---: | ---: | ---: |
| autocommit, client SELECT, sequential | 2597 | 2781 | 1.088x (+8.8%) | 0.99 to 1.17 | ±25.0% |
| autocommit, pool SELECT, sequential | 2922 | 2752 | 0.955x (-4.5%) | 0.89 to 1.05 | ±11.5% |
| autocommit, pool SELECT, concurrent x16 | 6227 | 5851 | 0.937x (-6.3%) | 0.84 to 1.04 | ±19.8% |
| autocommit, pool SELECT, fresh SQL, concurrent x16 | 6025 | 6042 | 1.023x (+2.3%) | 0.84 to 1.05 | ±27.0% |
| autocommit, client UPDATE, sequential | 874 | 883 | 1.028x (+2.8%) | 0.94 to 1.07 | ±14.8% |
| autocommit, pool UPDATE, concurrent x16 | 2311 | 2278 | 0.987x (-1.3%) | 0.82 to 1.01 | ±22.0% |

4 rounds of 1.5s per scenario, each round measuring base, head and a second process of each one after the other, in an order that changes every round. "Head / base" is the median of the per-round ratios and "Rounds" their range. "Noise" is how far base/base and head/head, the same code on both sides, got from 1 in this same run: that is what the machine did, so a row is marked only when the median moved further than that, at least 2%, and every round moved the same way: :eyes: slower, :trophy: faster. Only the ratio is comparable across runs, the absolute rates depend on the runner.

Node v22.22.1, AMD EPYC-Rome Processor, 4 cores.
