<!-- benchmark-comment -->

## Benchmark: `5cce72dd` against `5cce72dd`

Profile: row-formats.
Same checkout. Base: text results. Head: binary results. Named statements on both arms, no pipeline. A binary bytea codec is supplied explicitly; other codecs use pg-types. Rates count queries, not rows.

| Scenario | Base q/s | Head q/s | Head / base | Rounds | Noise |
| --- | ---: | ---: | ---: | ---: | ---: |
| text vs binary scalar object, 128 rows | 2153 | 1651 | 0.788x (-21.2%) | 0.70 to 0.86 | ±21.3% |
| text vs binary bytea object, 16 rows x16 KiB :trophy: | 551 | 1283 | 2.229x (**+122.9%**) | 2.12 to 2.69 | ±38.8% |

4 rounds of 3s per scenario, each round measuring base, head and a second process of each one after the other, in an order that changes every round. "Head / base" is the median of the per-round ratios and "Rounds" their range. "Noise" is how far base/base and head/head, the same code on both sides, got from 1 in this same run: that is what the machine did, so a row is marked only when the median moved further than that, at least 2%, and every round moved the same way: :eyes: slower, :trophy: faster. Only the ratio is comparable across runs, the absolute rates depend on the runner.

Node v22.22.1, AMD EPYC-Rome Processor, 4 cores.
