import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import type { ServerResponse } from 'node:http';
import Fastify from 'fastify';
import { config, DEAD_LETTER_QUEUE, QUEUE } from './config.js';
import { connectAmqp, createPool, createRedis, type OrderMessage } from './clients.js';
import { isAdmin, issueSession, verifySession } from './auth.js';
import { RELEASE_LUA, RESERVE_LUA } from './scripts.js';
import {
  ensureSale, newSaleId, readSale, SALE_KEY, saleKeys, STRATEGIES, type Sale, type Strategy,
} from './sale.js';
import { naiveCheckout, optimisticCheckout, pessimisticCheckout, type DbOrder } from './db-strategies.js';

const instanceId = hostname();
const ORDER_TTL_SECONDS = 24 * 3600;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{8,64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const app = Fastify({ logger: { level: 'info' }, disableRequestLogging: true, bodyLimit: 4096 });
const pool = createPool();
const redis = createRedis();
const { conn: amqpConn, ch } = await connectAmqp((m) => app.log.warn(m));

// A stateless API instance has to exit if it loses the queue; the orchestrator restarts it.
amqpConn.on('close', () => { app.log.error('RabbitMQ connection closed, exiting'); process.exit(1); });
amqpConn.on('error', (err) => app.log.error({ err }, 'RabbitMQ connection error'));
ch.on('close', () => { app.log.error('RabbitMQ channel closed, exiting'); process.exit(1); });
redis.defineCommand('reserve', { numberOfKeys: 4, lua: RESERVE_LUA });
redis.defineCommand('release', { numberOfKeys: 4, lua: RELEASE_LUA });

// ---------------------------------------------------------------------------
// Local view of the sale, refreshed every 500 ms. One Redis read per instance per
// tick, no matter how many clients are connected. Once stock reaches zero every
// instance answers "sold out" from memory without touching Redis at all.
// ---------------------------------------------------------------------------
let sale: Sale = await ensureSale(redis, pool);
let remaining = Number(await redis.get(saleKeys(sale.saleId).stock));
const sseClients = new Set<ServerResponse>();
let lastBroadcast = '';

function saleView(now = Date.now()) {
  const state = now < sale.startsAt ? 'upcoming' : remaining > 0 ? 'live' : 'sold_out';
  return {
    saleId: sale.saleId,
    product: { id: sale.productId, name: 'Nova X1', priceInr: 49999 },
    startsAt: sale.startsAt,
    serverTime: now,
    totalStock: sale.totalStock,
    remaining: Math.max(0, remaining),
    state,
    strategy: sale.strategy,
  };
}

async function refreshSale() {
  const fresh = await readSale(redis);
  if (fresh) sale = fresh;
  remaining = Number((await redis.get(saleKeys(sale.saleId).stock)) ?? 0);
  const view = saleView();
  const payload = JSON.stringify({ ...view, serverTime: undefined });
  if (payload !== lastBroadcast) {
    lastBroadcast = payload;
    const frame = `event: sale\ndata: ${JSON.stringify(view)}\n\n`;
    for (const res of sseClients) res.write(frame);
  }
}

setInterval(() => {
  refreshSale().catch((err) => app.log.error({ err }, 'sale refresh failed'));
}, 500).unref();
setInterval(() => {
  for (const res of sseClients) res.write(': keep-alive\n\n');
}, 15_000).unref();

// ---------------------------------------------------------------------------
// Response-code counters for the ops dashboard, flushed once a second.
// ---------------------------------------------------------------------------
let codeCounts: Record<string, number> = {};
setInterval(async () => {
  const counts = codeCounts;
  codeCounts = {};
  const entries = Object.entries(counts);
  if (entries.length === 0) return;
  const sec = Math.floor(Date.now() / 1000);
  const m = redis.multi();
  for (const [code, n] of entries) {
    m.hincrby(`stats:{${sale.saleId}}:codes`, code, n);
    m.hincrby(`stats:series:${sec}`, code, n);
  }
  m.expire(`stats:series:${sec}`, 300);
  m.hincrby(`stats:{${sale.saleId}}:instances`, instanceId, entries.reduce((a, [, n]) => a + n, 0));
  await m.exec().catch((err) => app.log.error({ err }, 'stats flush failed'));
}, 1000).unref();

app.addHook('onSend', async (_req, reply) => {
  reply.header('X-Served-By', instanceId);
});
app.addHook('onResponse', async (req, reply) => {
  if (req.routeOptions.url === '/api/checkout') {
    const code = String(reply.statusCode);
    codeCounts[code] = (codeCounts[code] ?? 0) + 1;
  }
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
app.get('/api/health', async () => ({ ok: true, instance: instanceId }));

app.post('/api/session', async (_req, reply) => reply.code(201).send(issueSession()));

app.get('/api/sale', async () => saleView());

// Server-Sent Events: one-way stream of sale state. Simpler than WebSockets for
// server-to-client updates and works through the load balancer as plain HTTP.
app.get('/api/sale/stream', (req, reply) => {
  reply.hijack();
  const res = reply.raw;
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    'X-Served-By': instanceId,
  });
  res.write(`retry: 3000\nevent: sale\ndata: ${JSON.stringify(saleView())}\n\n`);
  sseClients.add(res);
  req.raw.on('close', () => sseClients.delete(res));
});

function statusUrl(orderId: string) {
  return `/api/orders/${orderId}`;
}

app.post('/api/checkout', async (req, reply) => {
  const userId = verifySession(req.headers.authorization);
  if (!userId) return reply.code(401).send({ code: 'UNAUTHORIZED', message: 'Sign in first.' });

  const idemKey = req.headers['idempotency-key'];
  if (typeof idemKey !== 'string' || !IDEMPOTENCY_KEY.test(idemKey)) {
    return reply.code(400).send({ code: 'BAD_IDEMPOTENCY_KEY', message: 'Idempotency-Key header (8-64 chars) is required.' });
  }

  const now = Date.now();
  if (now < sale.startsAt) {
    return reply.code(425).send({ code: 'NOT_STARTED', message: 'The sale has not started yet.', startsAt: sale.startsAt });
  }
  // Fast path: this instance already knows stock is gone.
  if (remaining <= 0 && sale.strategy === 'queue') {
    return reply.code(409).send({ code: 'SOLD_OUT', message: 'Sold out.' });
  }

  const orderId = randomUUID();
  const order: DbOrder = { orderId, saleId: sale.saleId, productId: sale.productId, userId, idempotencyKey: idemKey };
  if (sale.strategy !== 'queue') return labCheckout(sale.strategy, order, reply);

  const keys = saleKeys(sale.saleId);
  const [status, existingId] = (await (redis as any).reserve(
    keys.stock, keys.buyers, keys.idem, keys.order(orderId),
    userId, orderId, idemKey, String(now), String(ORDER_TTL_SECONDS),
  )) as [string, string];

  switch (status) {
    case 'SOLD_OUT':
      remaining = 0;
      return reply.code(409).send({ code: 'SOLD_OUT', message: 'Sold out.' });
    case 'ALREADY_PURCHASED':
      return reply.code(409).send({
        code: 'ALREADY_PURCHASED', message: 'You already have an order in this sale.',
        orderId: existingId, statusUrl: statusUrl(existingId),
      });
    case 'DUPLICATE':
      // Same Idempotency-Key retried (double click, network retry): same answer as the first time.
      return reply.code(202).header('Location', statusUrl(existingId))
        .send({ orderId: existingId, status: 'PENDING', statusUrl: statusUrl(existingId) });
  }

  const message: OrderMessage = { ...order, createdAt: now };
  try {
    await new Promise<void>((resolve, reject) =>
      ch.sendToQueue(QUEUE, Buffer.from(JSON.stringify(message)),
        { persistent: true, contentType: 'application/json', messageId: orderId },
        (err) => (err ? reject(err) : resolve())));
  } catch (err) {
    req.log.error({ err, orderId }, 'queue publish failed, releasing reservation');
    await (redis as any).release(keys.stock, keys.buyers, keys.idem, keys.order(orderId),
      userId, orderId, idemKey, 'QUEUE_UNAVAILABLE');
    return reply.code(503).header('Retry-After', '2')
      .send({ code: 'TRY_AGAIN', message: 'We could not place your order. Please try again.' });
  }

  return reply.code(202).header('Location', statusUrl(orderId))
    .send({ orderId, status: 'PENDING', statusUrl: statusUrl(orderId) });
});

async function labCheckout(strategy: Strategy, order: DbOrder, reply: any) {
  const run = strategy === 'naive' ? naiveCheckout : strategy === 'pessimistic' ? pessimisticCheckout : optimisticCheckout;
  const result = await run(pool, order);
  switch (result.status) {
    case 'CONFIRMED':
      return reply.code(200).send({ orderId: result.orderId, status: 'CONFIRMED', attempts: result.attempts });
    case 'SOLD_OUT':
      return reply.code(409).send({ code: 'SOLD_OUT', message: 'Sold out.' });
    case 'ALREADY_PURCHASED':
      return reply.code(409).send({ code: 'ALREADY_PURCHASED', message: 'You already have an order in this sale.' });
    case 'CONFLICT':
      return reply.code(409).send({ code: 'CONFLICT', message: 'Too busy, please try again.', attempts: result.attempts });
    case 'LOCK_TIMEOUT':
      return reply.code(503).send({ code: 'LOCK_TIMEOUT', message: 'Timed out waiting for the inventory row lock.' });
  }
}

app.get<{ Params: { id: string } }>('/api/orders/:id', async (req, reply) => {
  const userId = verifySession(req.headers.authorization);
  if (!userId) return reply.code(401).send({ code: 'UNAUTHORIZED', message: 'Sign in first.' });
  const { id } = req.params;
  if (!UUID.test(id)) return reply.code(404).send({ code: 'NOT_FOUND', message: 'Order not found.' });

  const cached = await redis.hgetall(saleKeys(sale.saleId).order(id));
  if (cached.userId) {
    // Same answer for "not yours" and "does not exist", so order ids cannot be probed.
    if (cached.userId !== userId) return reply.code(404).send({ code: 'NOT_FOUND', message: 'Order not found.' });
    return { orderId: id, status: cached.status, reason: cached.reason };
  }
  const { rows } = await pool.query<{ status: string; user_id: string }>(
    'SELECT status, user_id FROM orders WHERE id = $1', [id]);
  if (rows.length === 0 || rows[0].user_id !== userId) {
    return reply.code(404).send({ code: 'NOT_FOUND', message: 'Order not found.' });
  }
  return { orderId: id, status: rows[0].status };
});

// Aggregate numbers only, no customer data. Used by the ops page and the tests.
app.get('/api/stats', async () => {
  const k = `{${sale.saleId}}`;
  const sec = Math.floor(Date.now() / 1000);
  const seriesKeys = Array.from({ length: 60 }, (_, i) => `stats:series:${sec - 60 + i}`);
  const [inv, orders, codes, instances, workers, redisStock, q, dlq, ...series] = await Promise.all([
    pool.query<{ stock: number }>('SELECT stock FROM inventory WHERE product_id = $1', [sale.productId]),
    pool.query<{ n: string }>("SELECT count(*) AS n FROM orders WHERE sale_id = $1 AND status = 'CONFIRMED'", [sale.saleId]),
    redis.hgetall(`stats:${k}:codes`),
    redis.hgetall(`stats:${k}:instances`),
    redis.hgetall(`stats:${k}:worker`),
    redis.get(saleKeys(sale.saleId).stock),
    ch.checkQueue(QUEUE),
    ch.checkQueue(DEAD_LETTER_QUEUE),
    ...seriesKeys.map((key) => redis.hgetall(key)),
  ]);
  return {
    sale: saleView(),
    redisStock: Number(redisStock ?? 0),
    dbStock: inv.rows[0]?.stock ?? null,
    confirmedOrders: Number(orders.rows[0].n),
    queue: { depth: q.messageCount, consumers: q.consumerCount, deadLetters: dlq.messageCount },
    responseCodes: codes,
    requestsByInstance: instances,
    ordersByWorker: workers,
    series: series.map((s, i) => ({ t: sec - 60 + i, codes: s })),
  };
});

// Admin: start a fresh sale. Clears orders and resets stock in both Redis and the database.
app.post<{ Body: { stock?: number; startsInSeconds?: number; strategy?: Strategy } }>('/api/admin/sale', {
  schema: {
    body: {
      type: 'object',
      additionalProperties: false,
      properties: {
        stock: { type: 'integer', minimum: 1, maximum: 100000 },
        startsInSeconds: { type: 'integer', minimum: 0, maximum: 86400 },
        strategy: { type: 'string', enum: STRATEGIES },
      },
    },
  },
}, async (req, reply) => {
  if (!isAdmin(req.headers['x-admin-token'] as string | undefined)) {
    return reply.code(401).send({ code: 'UNAUTHORIZED', message: 'Admin token required.' });
  }
  const stock = req.body?.stock ?? config.initialStock;
  const startsAt = Date.now() + (req.body?.startsInSeconds ?? 0) * 1000;
  const strategy = req.body?.strategy ?? 'queue';
  const saleId = newSaleId();

  await ch.purgeQueue(QUEUE);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('TRUNCATE orders');
    await client.query('UPDATE inventory SET stock = $2, version = 0 WHERE product_id = $1', [config.productId, stock]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
  const old = sale.saleId;
  await redis.multi()
    .del(saleKeys(old).stock, saleKeys(old).buyers, saleKeys(old).idem)
    .hset(SALE_KEY, 'saleId', saleId, 'productId', config.productId, 'startsAt', String(startsAt),
      'totalStock', String(stock), 'strategy', strategy)
    .set(saleKeys(saleId).stock, stock)
    .exec();
  await refreshSale();
  req.log.info({ saleId, stock, startsAt, strategy }, 'new sale started');
  return saleView();
});

app.setErrorHandler((err: any, req, reply) => {
  if (err.validation) return reply.code(400).send({ code: 'BAD_REQUEST', message: err.message });
  // Client errors raised by Fastify itself (bad JSON, unsupported media type, body too large).
  if (err.statusCode >= 400 && err.statusCode < 500) {
    return reply.code(err.statusCode).send({ code: err.code ?? 'BAD_REQUEST', message: err.message });
  }
  req.log.error({ err }, 'unhandled error');
  return reply.code(500).send({ code: 'INTERNAL', message: 'Something went wrong on our side.' });
});

const shutdown = async () => {
  for (const res of sseClients) res.end();
  await app.close();
  await amqpConn.close().catch(() => undefined);
  await pool.end();
  redis.disconnect();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

await app.listen({ port: config.port, host: '0.0.0.0' });
