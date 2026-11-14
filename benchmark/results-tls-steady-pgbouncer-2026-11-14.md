<!-- benchmark-comment -->

## Benchmark: `55bc7ad0` against `b54455de`

Profile: tls-steady.
Endpoint: pgbouncer-transaction (descriptive label).
Before/after checkouts, identical pipeline true and maxAutoPrepare 16 options. Verified TLS 1.3, shared context, direct negotiation; steady connections, SELECT-only.

| Scenario | Base q/s | Head q/s | Head / base | Rounds | Noise |
| --- | ---: | ---: | ---: | ---: | ---: |
| TLS steady, parameterized SELECT x16 | 14293 | 15182 | 1.072x (+7.2%) | 1.03 to 1.11 | ±29.2% |
| TLS steady, fresh SQL SELECT x16 | 11889 | 12970 | 1.118x (+11.8%) | 1.06 to 1.42 | ±53.8% |
| TLS steady, simple SELECT 1 x16 | 15383 | 17245 | 1.124x (+12.4%) | 0.89 to 1.29 | ±34.1% |
| TLS steady, bytea 2 x 1 MiB | 178 | 162 | 0.910x (-9.0%) | 0.85 to 0.97 | ±22.6% |

4 rounds of 2s per scenario, each round measuring base, head and a second process of each one after the other, in an order that changes every round. "Head / base" is the median of the per-round ratios and "Rounds" their range. "Noise" is how far base/base and head/head, the same code on both sides, got from 1 in this same run: that is what the machine did, so a row is marked only when the median moved further than that, at least 2%, and every round moved the same way: :eyes: slower, :trophy: faster. Only the ratio is comparable across runs, the absolute rates depend on the runner.

Node v22.22.1, AMD EPYC-Rome Processor, 4 cores.
