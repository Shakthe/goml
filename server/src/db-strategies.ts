import type { Pool, PoolClient } from 'pg';

// Synchronous, database-only checkout paths. They exist for the Oversell Lab so the
// queue-based design can be compared against them under the same load. Only the
// "queue" strategy is meant for production.

export type DbResult =
  | { status: 'CONFIRMED'; orderId: string; attempts?: number }
  | { status: 'SOLD_OUT' | 'ALREADY_PURCHASED' | 'CONFLICT' | 'LOCK_TIMEOUT'; attempts?: number };

export interface DbOrder {
  orderId: string;
  saleId: string;
  productId: string;
  userId: string;
  idempotencyKey: string;
}

const INSERT_ORDER = `INSERT INTO orders (id, sale_id, product_id, user_id, idempotency_key, status, strategy)
  VALUES ($1, $2, $3, $4, $5, 'CONFIRMED', $6)`;

function orderParams(o: DbOrder, strategy: string) {
  return [o.orderId, o.saleId, o.productId, o.userId, o.idempotencyKey, strategy];
}

function isUniqueViolation(err: unknown) {
  return (err as { code?: string }).code === '23505';
}

async function inTransaction<T>(pool: Pool, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * The original bug: read the stock, decide in application code, write back the value
 * we computed. Two requests that read "37" both write "36" and both insert an order.
 */
export async function naiveCheckout(pool: Pool, o: DbOrder): Promise<DbResult> {
  const { rows } = await pool.query<{ stock: number }>(
    'SELECT stock FROM inventory WHERE product_id = $1', [o.productId]);
  const stock = rows[0]?.stock ?? 0;
  if (stock <= 0) return { status: 'SOLD_OUT' };
  await pool.query('UPDATE inventory SET stock = $2 WHERE product_id = $1', [o.productId, stock - 1]);
  try {
    await pool.query(INSERT_ORDER, orderParams(o, 'naive'));
  } catch (err) {
    if (isUniqueViolation(err)) return { status: 'ALREADY_PURCHASED' };
    throw err;
  }
  return { status: 'CONFIRMED', orderId: o.orderId };
}

/** Pessimistic locking: correct, but every buyer queues on the same row lock. */
export async function pessimisticCheckout(pool: Pool, o: DbOrder): Promise<DbResult> {
  try {
    return await inTransaction(pool, async (c) => {
      await c.query("SET LOCAL lock_timeout = '2s'");
      const { rows } = await c.query<{ stock: number }>(
        'SELECT stock FROM inventory WHERE product_id = $1 FOR UPDATE', [o.productId]);
      if ((rows[0]?.stock ?? 0) <= 0) return { status: 'SOLD_OUT' } as DbResult;
      await c.query('UPDATE inventory SET stock = stock - 1 WHERE product_id = $1', [o.productId]);
      await c.query(INSERT_ORDER, orderParams(o, 'pessimistic'));
      return { status: 'CONFIRMED', orderId: o.orderId } as DbResult;
    });
  } catch (err) {
    if (isUniqueViolation(err)) return { status: 'ALREADY_PURCHASED' };
    if ((err as { code?: string }).code === '55P03') return { status: 'LOCK_TIMEOUT' };
    throw err;
  }
}

/** Optimistic locking: no lock is held, but most writers lose the version check under contention. */
export async function optimisticCheckout(pool: Pool, o: DbOrder, maxAttempts = 3): Promise<DbResult> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const { rows } = await pool.query<{ stock: number; version: number }>(
      'SELECT stock, version FROM inventory WHERE product_id = $1', [o.productId]);
    const row = rows[0];
    if (!row || row.stock <= 0) return { status: 'SOLD_OUT', attempts: attempt };
    try {
      const won = await inTransaction(pool, async (c) => {
        const upd = await c.query(
          `UPDATE inventory SET stock = stock - 1, version = version + 1
           WHERE product_id = $1 AND version = $2 AND stock > 0`, [o.productId, row.version]);
        if (upd.rowCount !== 1) return false;
        await c.query(INSERT_ORDER, orderParams(o, 'optimistic'));
        return true;
      });
      if (won) return { status: 'CONFIRMED', orderId: o.orderId, attempts: attempt };
    } catch (err) {
      if (isUniqueViolation(err)) return { status: 'ALREADY_PURCHASED', attempts: attempt };
      throw err;
    }
  }
  return { status: 'CONFLICT', attempts: maxAttempts };
}
