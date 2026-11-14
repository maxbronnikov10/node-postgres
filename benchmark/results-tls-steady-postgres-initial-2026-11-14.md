<!-- benchmark-comment -->

## Benchmark: `3519fe3d` against `b54455de`

Profile: tls-steady.
Endpoint: postgres (descriptive label).
Before/after checkouts, identical pipeline true and maxAutoPrepare 16 options. Verified TLS 1.3, shared context, direct negotiation; steady connections, SELECT-only.

| Scenario | Base q/s | Head q/s | Head / base | Rounds | Noise |
| --- | ---: | ---: | ---: | ---: | ---: |
| TLS steady, parameterized SELECT x16 :trophy: | 18912 | 22257 | 1.138x (**+13.8%**) | 1.03 to 1.25 | ±9.5% |
| TLS steady, fresh SQL SELECT x16 | 11723 | 13005 | 1.089x (+8.9%) | 1.05 to 1.18 | ±15.3% |
| TLS steady, simple SELECT 1 x16 :trophy: | 13933 | 18862 | 1.353x (**+35.3%**) | 1.18 to 1.44 | ±21.6% |
| TLS steady, bytea 2 x 1 MiB | 408 | 395 | 0.990x (-1.0%) | 0.90 to 1.05 | ±15.6% |

4 rounds of 2s per scenario, each round measuring base, head and a second process of each one after the other, in an order that changes every round. "Head / base" is the median of the per-round ratios and "Rounds" their range. "Noise" is how far base/base and head/head, the same code on both sides, got from 1 in this same run: that is what the machine did, so a row is marked only when the median moved further than that, at least 2%, and every round moved the same way: :eyes: slower, :trophy: faster. Only the ratio is comparable across runs, the absolute rates depend on the runner.

Node v22.22.1, AMD EPYC-Rome Processor, 4 cores.
