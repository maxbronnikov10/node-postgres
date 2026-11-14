<!-- benchmark-comment -->

## Benchmark: `0f5ba573` against `f6cbcbe5`

Profile: rows.
Endpoint: postgres-loopback (descriptive label).
Before/after checkouts, identical text result format, named statements and row shapes. Rates count queries, with the stated fixed row count per query. Every field is consumed and checked.

| Scenario | Base q/s | Head q/s | Head / base | Rounds | Noise |
| --- | ---: | ---: | ---: | ---: | ---: |
| text scalar object, 128 rows | 1929 | 2018 | 1.045x (+4.5%) | 0.99 to 1.13 | ±10.5% |
| text scalar array, 128 rows | 2190 | 2365 | 1.080x (+8.0%) | 1.00 to 1.12 | ±15.6% |
| text wide object, 128 rows x16 fields | 816 | 839 | 1.085x (+8.5%) | 0.88 to 1.13 | ±24.7% |
| text bytea object, 16 rows x16 KiB | 581 | 592 | 1.046x (+4.6%) | 0.95 to 1.09 | ±17.8% |

4 rounds of 3s per scenario, each round measuring base, head and a second process of each one after the other, in an order that changes every round. "Head / base" is the median of the per-round ratios and "Rounds" their range. "Noise" is how far base/base and head/head, the same code on both sides, got from 1 in this same run: that is what the machine did, so a row is marked only when the median moved further than that, at least 2%, and every round moved the same way: :eyes: slower, :trophy: faster. Only the ratio is comparable across runs, the absolute rates depend on the runner.

Node v22.22.1, AMD EPYC-Rome Processor, 4 cores.
