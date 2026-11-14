<!-- benchmark-comment -->

## Benchmark: `3519fe3d` against `b54455de`

Profile: tls-steady.
Endpoint: pgbouncer-transaction (descriptive label).
Before/after checkouts, identical pipeline true and maxAutoPrepare 16 options. Verified TLS 1.3, shared context, direct negotiation; steady connections, SELECT-only.

| Scenario | Base q/s | Head q/s | Head / base | Rounds | Noise |
| --- | ---: | ---: | ---: | ---: | ---: |
| TLS steady, parameterized SELECT x16 | 11479 | 13404 | 1.095x (+9.5%) | 1.09 to 1.29 | ±10.6% |
| TLS steady, fresh SQL SELECT x16 :trophy: | 9930 | 11215 | 1.151x (**+15.1%**) | 1.05 to 1.19 | ±10.3% |
| TLS steady, simple SELECT 1 x16 :trophy: | 12374 | 14002 | 1.137x (**+13.7%**) | 1.01 to 1.17 | ±13.6% |
| TLS steady, bytea 2 x 1 MiB | 177 | 164 | 0.941x (-5.9%) | 0.90 to 0.95 | ±11.7% |

4 rounds of 2s per scenario, each round measuring base, head and a second process of each one after the other, in an order that changes every round. "Head / base" is the median of the per-round ratios and "Rounds" their range. "Noise" is how far base/base and head/head, the same code on both sides, got from 1 in this same run: that is what the machine did, so a row is marked only when the median moved further than that, at least 2%, and every round moved the same way: :eyes: slower, :trophy: faster. Only the ratio is comparable across runs, the absolute rates depend on the runner.

Node v22.22.1, AMD EPYC-Rome Processor, 4 cores.
