| Strategy | Buyers | Units | Orders confirmed | Oversold | Conflicts (409) | Errors | Median ms | p95 ms | Max ms | Req/s |
|---|---|---|---|---|---|---|---|---|---|---|
| naive | 5000 | 500 | 5000 | **+4500** | 0 | 0 | 266.7 | 448.0 | 697 | 547 |
| pessimistic | 5000 | 500 | 500 | 0 | 0 | 0 | 259.2 | 468.1 | 1304 | 547 |
| optimistic | 5000 | 500 | 167 | 0 | 4833 | 0 | 261.4 | 412.7 | 632 | 523 |
| queue | 5000 | 500 | 500 | 0 | 0 | 0 | 18.8 | 74.3 | 146 | 1174 |
