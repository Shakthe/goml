import { hostname } from 'node:os';
import type { ConsumeMessage } from 'amqplib';
import { config, QUEUE } from './config.js';
import { connectAmqp, createPool, createRedis, type OrderMessage } from './clients.js';
import { RELEASE_LUA } from './scripts.js';
import { readSale, saleKeys } from './sale.js';

// The worker is the only place the queue path touches the database. It reads one
// message at a time (prefetch), writes the order in a single transaction and only
// acknowledges the message after the commit, so a crash means redelivery, not loss.

const workerId = hostname();
const log = (msg: string, extra: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ level: 'info', workerId, msg, ...extra }));
const logError = (msg: string, err: unknown, extra: Record<string, unknown> = {}) =>
  console.error(JSON.stringify({ level: 'error', workerId, msg, error: (err as Error).message, ...extra }));

const pool = createPool();
const redis = createRedis();

type Outcome = 'CONFIRMED' | 'DUPLICATE' | 'SOLD_OUT';

export async function persistOrder(m: OrderMessage): Promise<Outcome> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Insert first: if this message was already processed (redelivery), the unique
    // key makes this a no-op and we must not take stock a second time.
    const ins = await client.query(
      `INSERT INTO orders (id, sale_id, product_id, user_id, idempotency_key, status, strategy)
       VALUES ($1, $2, $3, $4, $5, 'CONFIRMED', 'queue')
       ON CONFLICT DO NOTHING RETURNING id`,
      [m.orderId, m.saleId, m.productId, m.userId, m.idempotencyKey],
    );
    if (ins.rowCount === 0) {
      await client.query('ROLLBACK');
      return 'DUPLICATE';
    }
    // The conditional decrement is the final guard. Even if Redis were wrong,
    // the database cannot go below zero (there is also a CHECK constraint).
    const upd = await client.query(
      'UPDATE inventory SET stock = stock - 1 WHERE product_id = $1 AND stock > 0',
      [m.productId],
    );
    if (upd.rowCount !== 1) {
      await client.query('ROLLBACK');
      return 'SOLD_OUT';
    }
    await client.query('COMMIT');
    return 'CONFIRMED';
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

async function main() {
  const { conn, ch } = await connectAmqp(log);
  // If RabbitMQ goes away, exit so Docker restarts the worker with a fresh connection.
  // Without this the process stays up but consumes nothing, and orders pile up in the queue.
  let stopping = false;
  const lost = (what: string) => () => {
    if (stopping) return;
    logError(`RabbitMQ ${what} closed, exiting`, new Error(`${what} closed`));
    process.exit(1);
  };
  conn.on('close', lost('connection'));
  conn.on('error', (err) => logError('RabbitMQ connection error', err));
  ch.on('close', lost('channel'));
  await ch.prefetch(config.workerPrefetch);
  log('worker ready', { queue: QUEUE, prefetch: config.workerPrefetch });

  await ch.consume(QUEUE, async (msg: ConsumeMessage | null) => {
    if (!msg) return;
    let m: OrderMessage;
    try {
      m = JSON.parse(msg.content.toString());
    } catch (err) {
      logError('unreadable message sent to dead-letter queue', err);
      ch.nack(msg, false, false);
      return;
    }
    const keys = saleKeys(m.saleId);
    try {
      const sale = await readSale(redis);
      if (!sale || sale.saleId !== m.saleId) {
        // The sale was reset by an admin after this order was queued.
        log('dropping order for old sale', { orderId: m.orderId, saleId: m.saleId });
        ch.ack(msg);
        return;
      }
      const outcome = await persistOrder(m);
      if (outcome === 'SOLD_OUT') {
        await redis.eval(RELEASE_LUA, 4, keys.stock, keys.buyers, keys.idem, keys.order(m.orderId),
          m.userId, m.orderId, m.idempotencyKey, 'SOLD_OUT_AT_DATABASE');
        log('database refused order, reservation released', { orderId: m.orderId });
      } else {
        // DUPLICATE means a redelivery of an order already in the database; make sure Redis agrees.
        await redis.hset(keys.order(m.orderId), 'status', 'CONFIRMED', 'confirmedAt', Date.now());
        if (outcome === 'CONFIRMED') await redis.hincrby(`stats:{${m.saleId}}:worker`, workerId, 1);
      }
      ch.ack(msg);
    } catch (err) {
      // Transient failure (database or Redis down). Requeue once; on the second
      // failure the message goes to the dead-letter queue for inspection.
      logError('failed to persist order', err, { orderId: m.orderId, redelivered: msg.fields.redelivered });
      ch.nack(msg, false, !msg.fields.redelivered);
    }
  });

  const shutdown = async () => {
    stopping = true;
    log('shutting down');
    await ch.close().catch(() => undefined);
    await conn.close().catch(() => undefined);
    await pool.end();
    redis.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  logError('worker crashed', err);
  process.exit(1);
});
