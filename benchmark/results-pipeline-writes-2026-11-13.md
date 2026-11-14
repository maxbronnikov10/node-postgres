<!-- benchmark-comment -->

## Benchmark: `07cb572d` against `2a5850fb`

| Scenario | Base q/s | Head q/s | Head / base | Rounds | Noise |
| --- | ---: | ---: | ---: | ---: | ---: |
| select parameter, pipelineBatchWrites x10 | 13605 | 15492 | 1.129x (+12.9%) | 0.98 to 1.17 | ±13.2% |

6 rounds of 3s per scenario, each round measuring base, head and a second process of each one after the other, in an order that changes every round. "Head / base" is the median of the per-round ratios and "Rounds" their range. "Noise" is how far base/base and head/head, the same code on both sides, got from 1 in this same run: that is what the machine did, so a row is marked only when the median moved further than that, at least 2%, and every round moved the same way: :eyes: slower, :trophy: faster. Only the ratio is comparable across runs, the absolute q/s depend on the runner.

Node v22.22.1, AMD EPYC-Rome Processor, 4 cores.
