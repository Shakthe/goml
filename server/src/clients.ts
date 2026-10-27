import { Redis } from 'ioredis';
import pg from 'pg';
import amqp from 'amqplib';
import { config, DEAD_LETTER_QUEUE, QUEUE } from './config.js';

export function createPool() {
  return new pg.Pool({ connectionString: config.databaseUrl, max: config.dbPoolSize });
}

export function createRedis() {
  return new Redis(config.redisUrl, { maxRetriesPerRequest: 3, enableAutoPipelining: true });
}

// Retries the initial connection so containers can start in any order.
export async function connectAmqp(log: (msg: string) => void) {
  for (let attempt = 1; ; attempt++) {
    try {
      const conn = await amqp.connect(config.amqpUrl);
      const ch = await conn.createConfirmChannel();
      await ch.assertQueue(DEAD_LETTER_QUEUE, { durable: true });
      await ch.assertQueue(QUEUE, {
        durable: true,
        arguments: { 'x-dead-letter-exchange': '', 'x-dead-letter-routing-key': DEAD_LETTER_QUEUE },
      });
      return { conn, ch };
    } catch (err) {
      if (attempt >= 30) throw err;
      log(`RabbitMQ not ready (attempt ${attempt}): ${(err as Error).message}`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

export interface OrderMessage {
  orderId: string;
  saleId: string;
  productId: string;
  userId: string;
  idempotencyKey: string;
  createdAt: number;
}
