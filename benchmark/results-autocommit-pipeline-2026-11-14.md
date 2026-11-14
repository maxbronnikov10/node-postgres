<!-- benchmark-comment -->

## Benchmark: `80eb86b4` against `80eb86b4`

Profile: autocommit-pipeline.
Same checkout. Base: pipeline false. Head: pipeline true. Both use maxAutoPrepare 16; no BEGIN. One client, concurrency: 16.

| Scenario | Base q/s | Head q/s | Head / base | Rounds | Noise |
| --- | ---: | ---: | ---: | ---: | ---: |
| autocommit, client SELECT, sequential | 4088 | 3342 | 0.900x (-10.0%) | 0.76 to 0.98 | ±21.0% |
| autocommit, client SELECT, concurrent x16 :trophy: | 3971 | 12429 | 3.130x (**+213.0%**) | 2.85 to 3.24 | ±33.8% |
| autocommit, client SELECT, fresh SQL, concurrent x16 :trophy: | 3233 | 6924 | 2.186x (**+118.6%**) | 2.06 to 2.37 | ±17.7% |
| autocommit, client UPDATE, concurrent x16 | 560 | 986 | 3.368x (+236.8%) | 0.86 to 19.93 | ±1655.8% |

4 rounds of 2s per scenario, each round measuring base, head and a second process of each one after the other, in an order that changes every round. "Head / base" is the median of the per-round ratios and "Rounds" their range. "Noise" is how far base/base and head/head, the same code on both sides, got from 1 in this same run: that is what the machine did, so a row is marked only when the median moved further than that, at least 2%, and every round moved the same way: :eyes: slower, :trophy: faster. Only the ratio is comparable across runs, the absolute rates depend on the runner.

Node v22.22.1, AMD EPYC-Rome Processor, 4 cores.
