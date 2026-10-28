# Requirement checklist

Every requirement in the case study, where it is implemented, and the evidence that it works.

## Problem statement

| Requirement | Where | Evidence |
|---|---|---|
| Exactly 500 sold, no overselling | [`server/src/scripts.ts`](../server/src/scripts.ts), [`server/src/worker.ts`](../server/src/worker.ts), [`infra/db/init.sql`](../infra/db/init.sql) | k6: 100,000 requests → exactly 500 orders, stock 0 in Redis and Postgres ([`evidence/k6/flash-sale-run.txt`](../evidence/k6/flash-sale-run.txt)). REST Assured `ConcurrencyTest` |
| No high latency, row locks or timeouts | Checkout path never touches Postgres | p95 24.9 ms, p99 47.5 ms over 100k requests, 0 timeouts. Lab: queue path p95 74 ms vs 468 ms with row locks |
| Reproduce the oversell bug | `naive` strategy in [`server/src/db-strategies.ts`](../server/src/db-strategies.ts) | 5,000 orders for 500 units ([`evidence/k6/lab-results.md`](../evidence/k6/lab-results.md)), screenshot [`11-ops-naive-oversold-2s.png`](../evidence/screenshots/11-ops-naive-oversold-2s.png) |

## Technical core requirements

| Layer | Requirement | Where | Evidence |
|---|---|---|---|
| Frontend | Stop repeated API calls from rapid clicks | [`checkout-machine.ts`](../web/src/checkout-machine.ts), ref lock in [`Storefront.tsx`](../web/src/components/Storefront.tsx), `Idempotency-Key` | Playwright: 5 clicks → 1 request. Vitest state-machine tests. REST Assured `idempotentRetry` |
| Frontend | Loading and failure states without freezing | Status line per state, retry keeps the same key, SSE → polling fallback | Screenshots `03` to `06` |
| Frontend | Bundle < 200 KB | Preact compat, code-split ops page, [`check-bundle.mjs`](../web/scripts/check-bundle.mjs) fails the build over budget | 45 KB raw / 17.5 KB gzip |
| Frontend | Time to Interactive < 1.5 s | Small bundle, preloaded image, no blocking work | Lighthouse mobile (throttled): 1.4 s, desktop 0.4 s ([`evidence/lighthouse/`](../evidence/lighthouse/)) |
| Gateway | Take massive parallel traffic without drops | NGINX with upstream keepalive, 16k connections per worker, fast in-memory sold-out path | 100,000 / 100,000 answered |
| Gateway | Block bot traffic, rate-limit bad actors | [`nginx.conf`](../infra/nginx/nginx.conf): per-IP `limit_req` and `limit_conn`, user-agent filter | k6 bot scenario: 97.5% got 429. REST Assured `GatewayTest` |
| Gateway | Distribute load across replicas | `upstream api_pool` over 4 API replicas | 25,003 to 25,009 requests per replica. REST Assured `loadBalanced` |
| App logic | Decouple DB writes from the request | RabbitMQ `checkout.orders`, workers, `202` + `Location` | REST Assured `acceptedThenConfirmed` |
| App logic | Stateless clusters | No session or stock state in process; `deploy.replicas` | Any replica serves any request (`X-Served-By` header) |
| App logic | Event-loop safety | No sync I/O, one HMAC + one Redis call per request, broadcast timer instead of per-client reads | p95 24.9 ms at ~11k requests/s on a laptop |
| Database | ACID, atomic decrements | Lua `DECR` in Redis. Worker transaction with `UPDATE ... WHERE stock > 0`. `CHECK (stock >= 0)`, unique constraints | Concurrency tests and k6 final checks |
| Database | No application-level double counters | Redis is the single counter; Postgres is reconciled through the same transaction that writes the order | Redis stock = Postgres stock after every run |

## Evaluation framework topics

| Topic | Covered in |
|---|---|
| Debouncing / throttling the button | Button state machine + ref lock + idempotency key ([ARCHITECTURE.md § Frontend](ARCHITECTURE.md#frontend)) |
| Asset pre-fetching | `<link rel="preload">` for the product image, Vite `modulepreload`, ops chunk prefetched on hover |
| Polling vs WebSockets | SSE with polling fallback, reasoning in [DECISIONS.md § 4](DECISIONS.md#4-server-sent-events-with-polling-as-a-fallback-instead-of-websockets) |
| Optimistic UI | "A unit is reserved for you" shown on 202, before the worker confirms |
| Load balancing | NGINX round robin with keepalive, 4 replicas |
| Distributed cache (Redis inventory tokens) | Stock counter + Lua reserve script |
| Message queue + workers | RabbitMQ with publisher confirms, manual ack, prefetch 1, dead-letter queue |
| Pessimistic vs optimistic locking, and why atomic Redis beats SELECT-then-UPDATE | All implemented and measured: [DECISIONS.md § 1](DECISIONS.md#1-redis-lua-script-as-the-gate-not-database-locks) |

## Model reference solution

| Step | Status |
|---|---|
| A1. Lock the UI on first click | Done |
| A2. Static assets from a CDN edge | NGINX serves hashed assets with `immutable` year-long caching (CDN stand-in), production note in ARCHITECTURE.md |
| A3. State manager, wait times via polling or SSE | Zustand + SSE + backoff polling |
| B1. NGINX / ALB load balancing to stateless servers | NGINX → 4 API replicas |
| B2. Redis inventory countdown, atomic decrements | Lua script |
| B3. Async queue, `202 Accepted` + polling URL | RabbitMQ, `Location: /api/orders/{id}` |
| C1. Consumers read the queue sequentially | Workers with `prefetch 1`, manual ack after commit |
| C2. `UPDATE inventory SET stock = stock - 1 WHERE product_id = :id AND stock > 0` | Exactly this statement in [`worker.ts`](../server/src/worker.ts), with bound parameters |
| C3. No race condition, no overselling | Proven by the tests above |

## Grading scorecard

| "Exemplary" criterion | Where |
|---|---|
| Identifies the N+1 and row-lock bottleneck | [ARCHITECTURE.md § The problem](ARCHITECTURE.md#the-problem-with-the-old-design), measured in the lab |
| Asynchronous queueing combined with atomic Redis tokens | The production `queue` strategy |
| UI bundle optimisation and edge CDN | 17.5 KB gzipped, budget enforced in the build, immutable caching |
