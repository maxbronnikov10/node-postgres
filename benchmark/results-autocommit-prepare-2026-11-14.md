<!-- benchmark-comment -->

## Benchmark: `80eb86b4` against `80eb86b4`

Profile: autocommit-prepare.
Same checkout. Base: maxAutoPrepare 0. Head: maxAutoPrepare 16. Pipeline disabled; no BEGIN. Pool max: 4; concurrency: 16.

| Scenario | Base q/s | Head q/s | Head / base | Rounds | Noise |
| --- | ---: | ---: | ---: | ---: | ---: |
| autocommit, client SELECT, sequential :trophy: | 2767 | 4015 | 1.430x (**+43.0%**) | 1.26 to 1.53 | ±22.4% |
| autocommit, pool SELECT, sequential :trophy: | 2706 | 3644 | 1.333x (**+33.3%**) | 1.28 to 1.44 | ±13.5% |
| autocommit, pool SELECT, concurrent x16 | 5828 | 8143 | 1.348x (+34.8%) | 1.19 to 1.40 | ±44.3% |
| autocommit, pool SELECT, fresh SQL, concurrent x16 | 6004 | 6466 | 1.071x (+7.1%) | 1.03 to 1.11 | ±8.0% |
| autocommit, client UPDATE, sequential | 951 | 1094 | 1.171x (+17.1%) | 0.90 to 1.20 | ±31.6% |
| autocommit, pool UPDATE, concurrent x16 | 2423 | 2678 | 1.130x (+13.0%) | 1.07 to 1.24 | ±23.3% |

4 rounds of 2s per scenario, each round measuring base, head and a second process of each one after the other, in an order that changes every round. "Head / base" is the median of the per-round ratios and "Rounds" their range. "Noise" is how far base/base and head/head, the same code on both sides, got from 1 in this same run: that is what the machine did, so a row is marked only when the median moved further than that, at least 2%, and every round moved the same way: :eyes: slower, :trophy: faster. Only the ratio is comparable across runs, the absolute rates depend on the runner.

Node v22.22.1, AMD EPYC-Rome Processor, 4 cores.
