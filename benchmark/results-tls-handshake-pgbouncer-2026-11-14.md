<!-- benchmark-comment -->

## Benchmark: `55bc7ad0` against `55bc7ad0`

Profile: tls-handshake.
Endpoint: pgbouncer-transaction (descriptive label).
Same checkout, verified TLS 1.3. Context row: base fresh context, head shared context, both postgres negotiation. Negotiation row: base postgres, head direct, both shared context.
Each connection includes connect, one SELECT and close. No session resumption is implemented.

| Scenario | Base connections/s | Head connections/s | Head / base | Rounds | Noise |
| --- | ---: | ---: | ---: | ---: | ---: |
| TLS handshake, fresh context vs shared context | 169 | 202 | 1.136x (+13.6%) | 1.04 to 1.39 | ±16.1% |
| TLS handshake, postgres vs direct negotiation | 192 | 209 | 1.089x (+8.9%) | 0.96 to 1.20 | ±12.5% |

4 rounds of 2s per scenario, each round measuring base, head and a second process of each one after the other, in an order that changes every round. "Head / base" is the median of the per-round ratios and "Rounds" their range. "Noise" is how far base/base and head/head, the same code on both sides, got from 1 in this same run: that is what the machine did, so a row is marked only when the median moved further than that, at least 2%, and every round moved the same way: :eyes: slower, :trophy: faster. Only the ratio is comparable across runs, the absolute rates depend on the runner.

Node v22.22.1, AMD EPYC-Rome Processor, 4 cores.
