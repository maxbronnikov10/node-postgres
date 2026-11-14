<!-- benchmark-comment -->

## Benchmark: `3f747c3d` against `f6cbcbe5`

Profile: rows.
Before/after checkouts, identical text result format, named statements and row shapes. Rates count queries, with the stated fixed row count per query. Every field is consumed and checked.

| Scenario | Base q/s | Head q/s | Head / base | Rounds | Noise |
| --- | ---: | ---: | ---: | ---: | ---: |
| text scalar object, 128 rows | 2258 | 2065 | 0.911x (-8.9%) | 0.87 to 0.97 | ±12.2% |
| text scalar array, 128 rows | 2446 | 2242 | 0.911x (-8.9%) | 0.85 to 0.97 | ±9.5% |
| text wide object, 128 rows x16 fields :eyes: | 862 | 817 | 0.942x (**-5.8%**) | 0.90 to 0.97 | ±4.5% |
| text bytea object, 16 rows x16 KiB | 587 | 568 | 0.969x (-3.1%) | 0.91 to 1.09 | ±10.3% |

4 rounds of 3s per scenario, each round measuring base, head and a second process of each one after the other, in an order that changes every round. "Head / base" is the median of the per-round ratios and "Rounds" their range. "Noise" is how far base/base and head/head, the same code on both sides, got from 1 in this same run: that is what the machine did, so a row is marked only when the median moved further than that, at least 2%, and every round moved the same way: :eyes: slower, :trophy: faster. Only the ratio is comparable across runs, the absolute rates depend on the runner.

Node v22.22.1, AMD EPYC-Rome Processor, 4 cores.
