# Testing

Everything runs against the real stack (`docker compose up -d --build`): NGINX, 4 API replicas, 2 workers, Redis, RabbitMQ and Postgres. There are no mocks in the API, load or browser tests.

On Git Bash for Windows, set `MSYS_NO_PATHCONV=1` before the k6 commands so the container paths are not rewritten.

## 1. API tests: REST Assured + JUnit 5

`tests/api/` · 18 tests · run in a Maven container on the compose network, so nothing needs installing:

```
docker compose --profile test run --rm api-tests
```

| Class | What it checks |
|---|---|
| `CheckoutApiTest` | Sale view contract; `425` before start; `202` + `Location` then `CONFIRMED` via the worker; idempotent retry returns the same order; one order per customer; `409 SOLD_OUT`; `401` on missing or forged tokens; `400` on a bad idempotency key; an order is visible only to its owner (`404` for others); admin auth and input validation; malformed requests get 4xx, never 500 |
| `GatewayTest` | Bot user agents get `403`; one IP hammering gets `429` while other IPs are served; traffic reaches several replicas; hashed assets have `immutable` cache headers |
| `ConcurrencyTest` | 1,000 buyers released at the same instant (100 threads) for 50 units, per strategy. `queue`: exactly 50 `202`, 950 `409`, then 50 orders and stock 0 in both stores, empty queue, no dead letters. `naive`: oversells (the original bug). `pessimistic`: exactly 50. `optimistic`: never more than 50 |

Last run: **18 passed, 0 failed** ([`evidence/api-tests/rest-assured-run.txt`](../evidence/api-tests/rest-assured-run.txt), JUnit XML in [`evidence/api-tests/surefire/`](../evidence/api-tests/surefire/)).

```
[queue]       1000 buyers, 50 units -> responses {202=50, 409=950}
[naive]       1000 buyers, 50 units -> responses {200=1000}   confirmed orders: 1000 for 50 units
[pessimistic] 1000 buyers, 50 units -> responses {200=50, 409=950}
[optimistic]  1000 buyers, 50 units -> responses {200=50, 409=950}
```

## 2. Load test: k6

### The 8 PM burst

```
docker compose --profile test run --rm k6 run --summary-export=/results/flash-sale-summary.json /scripts/flash-sale.js
```

- 100,000 checkout requests from 1,200 concurrent virtual users. Each request is a different customer with a different client IP.
- At the same time, a bot sends 100 requests per second from one IP for 10 seconds.
- Thresholds (the run fails if any is missed): every request answered, zero 5xx, zero no-response, buyer p95 < 1 s, more than 90% of bot requests rate-limited. After the queue drains: exactly 500 orders, stock 0 in Postgres and Redis, nothing dead-lettered.

Last run ([`evidence/k6/flash-sale-run.txt`](../evidence/k6/flash-sale-run.txt)):

```
buyers ✓ [ 100% ] 1200 VUs   0m08.8s   100000/100000 shared iters
FINAL confirmedOrders=500 dbStock=0 redisStock=0 queue={"consumers":2,"deadLetters":0,"depth":0}
  ✓ exactly 500 confirmed orders
  ✓ database stock is 0
  ✓ redis stock is 0
  ✓ queue drained, nothing dead-lettered
✓ checkout_answered.........: 100.00% 100000 out of 100000
✓ checkout_server_errors_5xx: 0
✓ checkout_no_response......: 0
✓ bot_requests_blocked......: 97.49%
  http_req_duration.........: med=55.36ms p(90)=144.41ms p(95)=191.06ms max=1.02s
```

A second run, with a browser screenshotting the ops page at the same time, is kept in [`flash-sale-run-while-screenshotting.txt`](../evidence/k6/flash-sale-run-while-screenshotting.txt): 100,000 requests in 14.1 s, same correctness results.

**About the numbers.** Everything ran on one 8-core laptop, with k6 competing for CPU with NGINX, the API replicas and the databases. The first attempt used a fixed arrival rate of 10,000 requests per second. k6 itself could not generate that rate on this machine and reported dropped iterations on its side, while the server still answered every request it received. So the test was changed to send exactly 100,000 requests as fast as possible, which reached about 11,000 per second. Real capacity numbers would need the load generator on separate machines.

### Oversell Lab

```
bash tests/load/run-lab.sh
```

The same burst (5,000 buyers, 500 units, 200 concurrent clients) against each strategy. The script writes [`evidence/k6/lab-results.md`](../evidence/k6/lab-results.md):

| Strategy | Buyers | Units | Orders confirmed | Oversold | Conflicts (409) | Errors | Median ms | p95 ms | Max ms | Req/s |
|---|---|---|---|---|---|---|---|---|---|---|
| naive | 5000 | 500 | 5000 | **+4500** | 0 | 0 | 266.7 | 448.0 | 697 | 547 |
| pessimistic | 5000 | 500 | 500 | 0 | 0 | 0 | 259.2 | 468.1 | 1304 | 547 |
| optimistic | 5000 | 500 | 167 | 0 | 4833 | 0 | 261.4 | 412.7 | 632 | 523 |
| queue | 5000 | 500 | 500 | 0 | 0 | 0 | 18.8 | 74.3 | 146 | 1174 |

## 3. Browser tests: Playwright

```
cd tests/e2e
npm ci
npx playwright install chromium        # or set PW_CHANNEL=chrome to use an installed Chrome
npx playwright test
```

| Test | Checks |
|---|---|
| Countdown before 8 PM | Timer visible, button disabled, live feed connected (desktop and mobile screenshots) |
| Sale opens | The button enables by itself when the start time passes, with no reload |
| Rapid clicks | Five clicks in one frame produce exactly **one** `/api/checkout` request; the order reaches "confirmed"; stock shows 499; after a reload the same customer is told they already have an order |
| Last unit | One buyer gets it; the other shopper's page switches to "Sold out" by itself via SSE |
| Ops page | Confirmed orders, Redis stock and database stock agree |

Last run: **5 passed** ([`evidence/e2e/playwright-run.txt`](../evidence/e2e/playwright-run.txt), HTML report in [`evidence/e2e/report/`](../evidence/e2e/report/)).

## 4. Unit tests: Vitest

```
cd web && npm test
```

6 tests for the buy-button state machine: locks after the first click, 202 → queued → confirmed, the mapping of 409/425/429, retry reuses the idempotency key, network errors are retryable, and no buying again after a final result.

## 5. Frontend performance: Lighthouse

```
npx lighthouse http://localhost:8080/ --only-categories=performance
```

| Profile | Score | FCP | LCP | Time to Interactive | TBT | Transferred |
|---|---|---|---|---|---|---|
| Mobile (Lighthouse default throttling) | 100 | 0.9 s | 1.4 s | **1.4 s** | 0 ms | 19 KiB |
| Desktop | 100 | 0.3 s | 0.4 s | **0.4 s** | 0 ms | 19 KiB |

Reports: [`evidence/lighthouse/`](../evidence/lighthouse/).

## Screenshots

| | |
|---|---|
| ![Countdown](../evidence/screenshots/01-countdown.png) | ![Live](../evidence/screenshots/02-live.png) |
| Before the sale | Sale open |
| ![Confirmed](../evidence/screenshots/04-confirmed.png) | ![Sold out](../evidence/screenshots/06-sold-out.png) |
| Order confirmed | Another shopper after the last unit |
| ![Ops during load](../evidence/screenshots/09-ops-during-load.png) | ![Naive oversold](../evidence/screenshots/11-ops-naive-oversold-2s.png) |
| Ops page during the 100k run | Ops page after a run with the naive strategy |
