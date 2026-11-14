<!-- benchmark-comment -->

## Benchmark: `55bc7ad0` against `b54455de`

Profile: tls-steady.
Endpoint: postgres (descriptive label).
Before/after checkouts, identical pipeline true and maxAutoPrepare 16 options. Verified TLS 1.3, shared context, direct negotiation; steady connections, SELECT-only.

| Scenario | Base q/s | Head q/s | Head / base | Rounds | Noise |
| --- | ---: | ---: | ---: | ---: | ---: |
| TLS steady, parameterized SELECT x16 | 19345 | 21831 | 1.049x (+4.9%) | 0.85 to 1.53 | ±43.2% |
| TLS steady, fresh SQL SELECT x16 | 12595 | 13553 | 1.085x (+8.5%) | 1.07 to 1.35 | ±33.8% |
| TLS steady, simple SELECT 1 x16 | 16290 | 19437 | 1.180x (+18.0%) | 1.16 to 1.25 | ±23.6% |
| TLS steady, bytea 2 x 1 MiB | 432 | 440 | 1.041x (+4.1%) | 0.95 to 1.09 | ±10.6% |

4 rounds of 2s per scenario, each round measuring base, head and a second process of each one after the other, in an order that changes every round. "Head / base" is the median of the per-round ratios and "Rounds" their range. "Noise" is how far base/base and head/head, the same code on both sides, got from 1 in this same run: that is what the machine did, so a row is marked only when the median moved further than that, at least 2%, and every round moved the same way: :eyes: slower, :trophy: faster. Only the ratio is comparable across runs, the absolute rates depend on the runner.

Node v22.22.1, AMD EPYC-Rome Processor, 4 cores.
