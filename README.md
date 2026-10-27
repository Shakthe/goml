# Flash Sale: 500 phones, 100,000 requests, zero oversells

A working checkout system for the festival flash sale case study. 500 units of one phone go on sale at 8:00 PM, and a very large number of people try to buy at the same moment.

The old system oversold (540 orders for 500 phones), locked up the database and timed out. This version sells exactly 500, answers every request quickly and keeps the database out of the hot path.

```
docker compose up -d --build
open http://localhost:8080        # store
open http://localhost:8080/ops    # live numbers, and a form to start a new sale
```

The default sale opens at 8:00 PM IST today. To try it right away, go to `/ops`, enter the admin token `dev-admin-token` and start a sale that opens in 30 seconds.

## Measured results

All numbers below were measured on one laptop (8 cores, Docker Desktop on Windows) running the whole stack *and* the load generator at the same time. Raw outputs are in [`evidence/`](evidence/).

**The 8 PM test** (k6, [`tests/load/flash-sale.js`](tests/load/flash-sale.js)): 100,000 checkout requests from 1,200 concurrent clients, plus one bot hammering from a single IP.

| | Result |
|---|---|
| Checkout requests sent | 100,000 in 8.8 s (about 11,000 per second) |
| Requests answered | 100,000 (100%). No timeouts, no connection errors, no 5xx |
| Orders confirmed in Postgres | **exactly 500** |
| Stock left in Redis / Postgres | 0 / 0 |
| Latency | median 55 ms, p95 191 ms |
| Load per API replica | 25,005 to 25,007 requests each (4 replicas) |
| Bot requests rate limited | 97.5% (the rest is the allowed burst of 5 plus 2 per second) |

**Oversell Lab** (same burst against four checkout strategies: 5,000 buyers, 500 units, [`evidence/k6/lab-results.md`](evidence/k6/lab-results.md)):

| Strategy | Orders for 500 units | Median | p95 | Notes |
|---|---|---|---|---|
| Naive `SELECT` then `UPDATE` (the old code) | **5,000** | 267 ms | 448 ms | Lost updates, oversold by 4,500 |
| Pessimistic `SELECT ... FOR UPDATE` | 500 | 259 ms | 468 ms | Correct, but every buyer waits on one row lock |
| Optimistic (version column, 3 retries) | 167 | 261 ms | 413 ms | Never oversells, but **undersold**: 4,833 buyers were turned away while stock was left |
| **Redis Lua + RabbitMQ + worker (this design)** | **500** | **19 ms** | **74 ms** | Correct and about 14x faster at the median |

**Frontend**: 45 KB of JS and CSS (17.5 KB gzipped) against a 200 KB budget that the build enforces. Lighthouse Time to Interactive is 1.4 s on its throttled mobile profile and 0.4 s on desktop, with a performance score of 100 ([`evidence/lighthouse/`](evidence/lighthouse/)).

## How it works

```
Browser ──> NGINX gateway ──> API x4 (Node + TypeScript, stateless)
            static files        │ 1. Redis Lua script: check stock, one per customer,
            rate limits         │    idempotency, take one unit. All in one atomic step.
            bot filter          │ 2. Publish the order to RabbitMQ (with publisher confirm)
            load balancing      │ 3. Reply 202 Accepted + /api/orders/{id}
                                ▼
                            RabbitMQ ──> Workers x2 ──> Postgres
                                         one transaction per order:
                                         INSERT order, then
                                         UPDATE inventory SET stock = stock - 1
                                         WHERE product_id = $1 AND stock > 0
```

- **The checkout request never touches Postgres.** Redis decides who gets a unit, in a single Lua script, which Redis runs atomically. Once stock reaches zero, every API replica answers "sold out" from memory without calling Redis at all.
- **Postgres stays the source of truth** and has the final say: a conditional decrement, `CHECK (stock >= 0)`, and unique constraints on (sale, user) and (sale, idempotency key). Even if Redis were wrong, the database could not oversell.
- **Every request gets an answer**: `202` accepted, `409` sold out or already ordered, `425` too early, `429` rate limited, `403` bot. Nothing waits on a lock, so nothing times out.
- **The browser** locks the button on the first click, sends an `Idempotency-Key` (a retry can never create a second order), gets live stock over Server-Sent Events (falls back to polling), and polls the order status with backoff and jitter.

More detail: [Architecture](docs/ARCHITECTURE.md) · [Decisions and trade-offs](docs/DECISIONS.md) · [Requirement checklist](docs/REQUIREMENTS.md) · [Testing](docs/TESTING.md)

## Tests

| What | Tool | Command | Result |
|---|---|---|---|
| API behaviour, gateway, concurrency (18 tests) | REST Assured + JUnit 5 | `docker compose --profile test run --rm api-tests` | 18/18 pass |
| 100k request burst | k6 | `docker compose --profile test run --rm k6 run /scripts/flash-sale.js` | all thresholds pass |
| Strategy comparison | k6 | `bash tests/load/run-lab.sh` | table above |
| Browser flows + screenshots | Playwright | `cd tests/e2e && npm ci && npx playwright test` | 5/5 pass |
| Buy-button state machine | Vitest | `cd web && npm test` | 6/6 pass |

On Git Bash for Windows, prefix the k6 command with `MSYS_NO_PATHCONV=1`.

## Repository layout

```
server/        API and worker (Node 22, TypeScript, Fastify, ioredis, amqplib, pg)
web/           Storefront and ops page (React API on Preact, Vite, Zustand)
infra/nginx/   Gateway config and the image that serves the built frontend
infra/db/      Postgres schema and seed
tests/api/     REST Assured tests (Maven, run in Docker)
tests/load/    k6 scripts
tests/e2e/     Playwright tests, screenshot and Lighthouse scripts
docs/          Architecture, decisions, requirement checklist, testing
evidence/      Test outputs and screenshots from the runs above
```

## What is simplified

- **Payment** is out of scope: a confirmed order means a unit is held for the customer. In production the worker would create a payment intent, and an unpaid hold would expire and put the unit back (the `release` Lua script already does this for failed orders).
- **Sign-in** is an anonymous signed session token per browser, enough to enforce one unit per customer.
- **CDN**: NGINX serves the hashed static files with year-long immutable cache headers, which is exactly what a CDN would cache at the edge. In production this sits behind CloudFront or Cloudflare.
- **Single Redis and RabbitMQ node** here. Production would use Redis with a replica and Sentinel (or Cluster; the keys already use hash tags) and a 3-node RabbitMQ cluster with quorum queues.
