<!-- benchmark-comment -->

## Benchmark: `7aed08ba` against `209b87c3`

Profile: payload.

| Scenario | Base q/s | Head q/s | Head / base | Rounds | Noise |
| --- | ---: | ---: | ---: | ---: | ---: |
| payload, explicit batch 2 x 1 MiB | 628 | 735 | 1.204x (+20.4%) | 1.01 to 1.25 | ±21.9% |
| payload, explicit batch 2 x 8 MiB :trophy: | 83 | 97 | 1.160x (**+16.0%**) | 1.15 to 1.18 | ±10.6% |

4 rounds of 2s per scenario, each round measuring base, head and a second process of each one after the other, in an order that changes every round. "Head / base" is the median of the per-round ratios and "Rounds" their range. "Noise" is how far base/base and head/head, the same code on both sides, got from 1 in this same run: that is what the machine did, so a row is marked only when the median moved further than that, at least 2%, and every round moved the same way: :eyes: slower, :trophy: faster. Only the ratio is comparable across runs, the absolute rates depend on the runner.

Node v22.22.1, AMD EPYC-Rome Processor, 4 cores.
