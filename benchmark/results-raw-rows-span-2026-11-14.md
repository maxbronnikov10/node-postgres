<!-- benchmark-comment -->

## Benchmark: `5cce72dd` against `f6cbcbe5`

Profile: rows.
Before/after checkouts, identical text result format, named statements and row shapes. Rates count queries, with the stated fixed row count per query. Every field is consumed and checked.

| Scenario | Base q/s | Head q/s | Head / base | Rounds | Noise |
| --- | ---: | ---: | ---: | ---: | ---: |
| text scalar object, 128 rows | 2192 | 2096 | 0.950x (-5.0%) | 0.91 to 1.02 | ±21.0% |
| text scalar array, 128 rows | 2058 | 2013 | 0.980x (-2.0%) | 0.93 to 1.02 | ±12.5% |
| text wide object, 128 rows x16 fields | 823 | 721 | 0.910x (-9.0%) | 0.85 to 0.93 | ±20.8% |
| text bytea object, 16 rows x16 KiB | 500 | 520 | 1.015x (+1.5%) | 0.88 to 1.65 | ±53.9% |

4 rounds of 3s per scenario, each round measuring base, head and a second process of each one after the other, in an order that changes every round. "Head / base" is the median of the per-round ratios and "Rounds" their range. "Noise" is how far base/base and head/head, the same code on both sides, got from 1 in this same run: that is what the machine did, so a row is marked only when the median moved further than that, at least 2%, and every round moved the same way: :eyes: slower, :trophy: faster. Only the ratio is comparable across runs, the absolute rates depend on the runner.

Node v22.22.1, AMD EPYC-Rome Processor, 4 cores.
