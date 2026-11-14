<!-- benchmark-comment -->

## Benchmark: `209b87c3` against `209b87c3`

Profile: ablation.
Same checkout on all arms. Base: pipeline only. Head: named option combination; identical transaction workload.

| Scenario | Base q/s | Head q/s | Head / base | Rounds | Noise |
| --- | ---: | ---: | ---: | ---: | ---: |
| ablation, coalescing only | 10299 | 9633 | 0.956x (-4.4%) | 0.84 to 1.05 | ±30.9% |
| ablation, autoBatch only | 5428 | 9740 | 1.729x (+72.9%) | 1.49 to 2.42 | ±108.3% |
| ablation, prepare only | 6302 | 7614 | 1.230x (+23.0%) | 1.15 to 1.37 | ±34.9% |
| ablation, autoBatch + prepare :trophy: | 8770 | 16529 | 1.866x (**+86.6%**) | 1.65 to 3.19 | ±50.3% |
| ablation, all three | 9472 | 15981 | 1.708x (+70.8%) | 1.52 to 3.60 | ±74.1% |

4 rounds of 3s per scenario, each round measuring base, head and a second process of each one after the other, in an order that changes every round. "Head / base" is the median of the per-round ratios and "Rounds" their range. "Noise" is how far base/base and head/head, the same code on both sides, got from 1 in this same run: that is what the machine did, so a row is marked only when the median moved further than that, at least 2%, and every round moved the same way: :eyes: slower, :trophy: faster. Only the ratio is comparable across runs, the absolute rates depend on the runner.

Node v22.22.1, AMD EPYC-Rome Processor, 4 cores.
