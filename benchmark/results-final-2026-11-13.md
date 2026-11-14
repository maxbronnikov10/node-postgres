<!-- benchmark-comment -->

## Benchmark: `7aed08ba` against `2a5850fb`

Profile: regression.
Baseline checkouts may ignore unsupported optimization options; these rows do not imply baseline support.

| Scenario | Base q/s | Head q/s | Head / base | Rounds | Noise |
| --- | ---: | ---: | ---: | ---: | ---: |
| select 1 row, all types, prepared :trophy: | 2135 | 2528 | 1.136x (**+13.6%**) | 1.06 to 1.20 | ±12.7% |
| select 100 rows, all types, prepared | 640 | 648 | 1.014x (+1.4%) | 0.98 to 1.08 | ±21.4% |
| select 500 rows, all types, prepared | 182 | 173 | 0.954x (-4.6%) | 0.86 to 1.11 | ±16.0% |
| select 500 rows, simple types, prepared | 814 | 857 | 1.062x (+6.2%) | 0.95 to 1.11 | ±13.8% |
| select 500 rows, simple types, array mode | 762 | 780 | 1.018x (+1.8%) | 0.98 to 1.11 | ±10.9% |
| select 500 rows, simple types, binary | 522 | 506 | 0.966x (-3.4%) | 0.89 to 1.10 | ±16.5% |
| select by id, parameterized | 2287 | 2231 | 0.971x (-2.9%) | 0.94 to 1.04 | ±12.8% |
| select parameter, config object | 3336 | 3659 | 1.078x (+7.8%) | 0.93 to 1.35 | ±30.4% |
| select parameter, maxAutoPrepare :trophy: | 3556 | 4923 | 1.404x (**+40.4%**) | 1.35 to 1.42 | ±13.0% |
| transaction, explicit batch x10 :trophy: | 8364 | 12158 | 1.548x (**+54.8%**) | 1.29 to 1.78 | ±36.7% |
| transaction, named cached batch x10 :trophy: | 8831 | 12844 | 1.513x (**+51.3%**) | 1.21 to 1.56 | ±27.1% |
| transaction, autoBatch x10 :trophy: | 6455 | 14043 | 2.136x (**+113.6%**) | 2.07 to 2.41 | ±14.6% |
| pool contention, max 1, select parameter x10 | 2798 | 2789 | 0.981x (-1.9%) | 0.97 to 1.14 | ±17.5% |
| insert, all types, returning | 1579 | 1527 | 0.989x (-1.1%) | 0.91 to 1.02 | ±16.1% |
| update, parameterized | 2293 | 2227 | 0.974x (-2.6%) | 0.94 to 1.07 | ±21.5% |
| delete, parameterized | 2738 | 2568 | 0.974x (-2.6%) | 0.92 to 1.31 | ±52.1% |
| transaction, 3 queries | 4094 | 3795 | 0.915x (-8.5%) | 0.79 to 1.07 | ±28.4% |
| pool query, select 1 row | 2194 | 2166 | 0.964x (-3.6%) | 0.93 to 1.06 | ±11.8% |
| cursor, 500 rows in 5 reads | 122 | 112 | 0.914x (-8.6%) | 0.77 to 1.00 | ±29.4% |
| query stream, 500 rows | 113 | 104 | 0.902x (-9.8%) | 0.88 to 1.10 | ±20.9% |
| select 100 rows, all types, pipelined x10 | 758 | 717 | 0.958x (-4.2%) | 0.85 to 1.01 | ±17.3% |

4 rounds of 0.5s per scenario, each round measuring base, head and a second process of each one after the other, in an order that changes every round. "Head / base" is the median of the per-round ratios and "Rounds" their range. "Noise" is how far base/base and head/head, the same code on both sides, got from 1 in this same run: that is what the machine did, so a row is marked only when the median moved further than that, at least 2%, and every round moved the same way: :eyes: slower, :trophy: faster. Only the ratio is comparable across runs, the absolute rates depend on the runner.

Node v22.22.1, AMD EPYC-Rome Processor, 4 cores.
