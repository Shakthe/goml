# Decisions and trade-offs

Short notes on the choices that matter, what else was considered, and why.

## 1. Redis Lua script as the gate, not database locks

The case study asks to compare pessimistic locking, optimistic locking and an atomic Redis operation. Instead of arguing it, the repo runs all of them under the same load ([Oversell Lab](../evidence/k6/lab-results.md)). With 5,000 buyers for 500 units:

| Strategy | Orders | Median | p95 | What went wrong |
|---|---|---|---|---|
| Naive `SELECT` then `UPDATE` | 5,000 | 267 ms | 448 ms | Lost updates: many requests read the same stock value, each wrote back value - 1 and each inserted an order |
| Pessimistic `SELECT ... FOR UPDATE` | 500 | 259 ms | 468 ms | Correct, but all buyers queue behind one row lock while holding a DB connection. Under more load this turns into lock timeouts (the code maps `lock_timeout` to a 503) |
| Optimistic (version column, 3 retries) | 167 | 261 ms | 413 ms | Correct but unfair: when everyone updates the same row, almost every version check fails. 4,833 buyers were told "try again" while 333 units were still unsold |
| Redis Lua + queue | 500 | 19 ms | 74 ms | - |

Why the Lua script is safe: Redis runs commands and scripts one at a time on a single thread, so the script's read of the stock and its `DECR` cannot be interleaved with another buyer's. A plain `DECR` alone would also be atomic, but the script additionally checks "this user already bought" and "this idempotency key was already used" in the same step, which a single command cannot do.

Why the database still has guards: Redis is fast but it is a cache. If it lost data or someone changed a key by hand, the database must still refuse to oversell. The worker's `UPDATE ... WHERE stock > 0`, the `CHECK (stock >= 0)` and the unique constraints make that impossible regardless of what Redis says.

## 2. Accept fast, write later (202 + queue)

The checkout request does the minimum: verify, reserve in Redis, publish, reply `202 Accepted` with a status URL. The database write happens in a worker.

- **Why:** a database can handle 500 inserts easily. It cannot handle 100,000 transactions on one row within 10 seconds. Only requests that actually won a unit ever reach the database, so database load is bounded by stock, not by traffic.
- **Cost:** the customer sees "reserved, confirming" for a moment before "confirmed". In the tests the worker confirms within a few hundred milliseconds.
- **Publisher confirms:** the API waits for RabbitMQ to confirm it has the message before replying 202. If the publish fails, the reservation is undone and the customer gets a 503 they can retry. An accepted order is never lost silently.

## 3. RabbitMQ rather than Kafka

Both were named in the brief. RabbitMQ fits this job better:

- Per-message acknowledgement, redelivery and a dead-letter queue out of the box. That is exactly what an order pipeline needs.
- The volume is small (one message per unit sold, so 500), and nobody needs to replay history.
- Kafka would be the choice for a high-volume event stream that several consumers read independently (analytics, notifications, fraud checks). That could be added later by having the worker publish "order confirmed" events.

## 4. Server-Sent Events, with polling as a fallback, instead of WebSockets

Sale status only flows one way (server to browser): stock left, sale started, sold out.

- SSE is plain HTTP. It passes through NGINX, CDNs and corporate proxies without special setup, reconnects automatically, and costs one idle connection per browser.
- WebSockets add a second protocol to load-balance and secure, for a channel the browser never sends on.
- Each API replica reads Redis once every 500 ms and broadcasts only when the value changed. So 100,000 connected browsers cost each replica two Redis reads per second, not 100,000.
- If SSE fails three times in a row (for example a proxy that buffers it), the page switches to polling every 2 to 3 seconds with jitter.
- Order status uses polling with exponential backoff and jitter, as the brief's 202 + tracking URL model suggests. One order per customer means at most one poll loop per browser.

## 5. Every request gets an answer

"0% dropped requests" is read as: every request receives a correct, fast response. It does not mean every request gets a phone.

| Situation | Response | Served from |
|---|---|---|
| Unit reserved | `202` + `Location` | Redis |
| Same idempotency key again | `202`, same order | Redis |
| Sold out | `409 SOLD_OUT` | API memory once stock is known to be 0 |
| Already bought | `409 ALREADY_PURCHASED` + link | Redis |
| Too early | `425 NOT_STARTED` + start time | API memory |
| Too many requests from one IP | `429` | NGINX |
| Known bot user agent | `403` | NGINX |

In the 100k test, 100% of requests were answered with no timeouts or 5xx errors.

## 6. Bot and abuse protection: layered, and honest about its limits

- NGINX per-IP rate limit on checkout (2 per second, burst 5) and a connection limit. A human clicks once.
- Requests with no user agent or a scraping library's user agent are refused at the edge.
- One order per customer and idempotency keys, enforced atomically in Redis.
- Signed session tokens (HMAC) so user ids cannot be invented.

A determined bot farm with many IPs and real browsers gets past simple rules. In production that is the job of the CDN's bot management (Cloudflare or AWS WAF bot control) plus a sign-in requirement. The layers here are the in-house second line.

## 7. Frontend: React API on Preact, Zustand, no UI library

- The brief sets a 200 KB bundle budget. With React DOM the minified app was 240 KB raw (76 KB gzipped): under budget gzipped, over budget raw. Building the same code with `preact/compat` brings it to 47.5 KB raw (18 KB gzipped), which meets the budget under either reading. The code is ordinary React with hooks.
- Zustand (about 1 KB) holds the sale, server clock offset, feed state and checkout state.
- No CSS framework: about 7 KB of hand-written CSS for a plain, white product page laid out like a large online store (image, details, buy box).
- Lighthouse on its throttled mobile profile: Time to Interactive 1.4 s, performance score 100.

## 8. Stateless API, replicated

The API keeps nothing that matters in memory. The cached sale view and the "sold out" flag are refreshed from Redis every 500 ms, and losing them just means a Redis read. Docker Compose runs 4 API replicas and 2 workers, and NGINX round-robins across them (the k6 runs show 25,004 to 25,010 requests per replica). If an API loses its RabbitMQ connection it exits and is restarted rather than limping on.

Node's event loop is kept free: no synchronous I/O, no CPU-heavy work in the request path (one HMAC and one Redis call), and Redis commands are auto-pipelined by ioredis.

## 9. What was left out on purpose

- **Payment.** A confirmed order holds a unit. The next step would be a payment intent with a hold timeout; the `release` script already returns a unit to stock for an order that fails.
- **Accounts.** Anonymous signed sessions are enough to enforce one unit per customer in a demo.
- **Waiting room.** Not needed at this scale, because sold-out answers are served from memory. It would be the next step if traffic grew by another order of magnitude.
