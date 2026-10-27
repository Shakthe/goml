import { randomBytes } from 'node:crypto';
import type { Redis } from 'ioredis';
import type { Pool } from 'pg';
import { config } from './config.js';

export type Strategy = 'queue' | 'naive' | 'pessimistic' | 'optimistic';
export const STRATEGIES: Strategy[] = ['queue', 'naive', 'pessimistic', 'optimistic'];

export interface Sale {
  saleId: string;
  productId: string;
  startsAt: number; // epoch ms
  totalStock: number;
  strategy: Strategy;
}

export const SALE_KEY = 'sale:current';

export function saleKeys(saleId: string) {
  const tag = `{${saleId}}`;
  return {
    stock: `sale:${tag}:stock`,
    buyers: `sale:${tag}:buyers`,
    idem: `sale:${tag}:idem`,
    order: (orderId: string) => `sale:${tag}:order:${orderId}`,
  };
}

// Today's sale hour in the configured timezone (8:00 PM IST by default).
export function todaysSaleTime(now = Date.now()): number {
  const offsetMs = config.saleTimezoneOffsetMinutes * 60_000;
  const local = new Date(now + offsetMs);
  local.setUTCHours(config.saleHour, 0, 0, 0);
  return local.getTime() - offsetMs;
}

export function newSaleId(): string {
  return randomBytes(4).toString('hex');
}

export async function readSale(redis: Redis): Promise<Sale | null> {
  const h = await redis.hgetall(SALE_KEY);
  if (!h.saleId) return null;
  return {
    saleId: h.saleId,
    productId: h.productId,
    startsAt: Number(h.startsAt),
    totalStock: Number(h.totalStock),
    strategy: (h.strategy as Strategy) ?? 'queue',
  };
}

const INIT_SALE_LUA = `
if redis.call('EXISTS', KEYS[1]) == 1 then return 0 end
redis.call('HSET', KEYS[1], 'saleId', ARGV[1], 'productId', ARGV[2], 'startsAt', ARGV[3], 'totalStock', ARGV[4], 'strategy', 'queue')
redis.call('SET', KEYS[2], ARGV[5])
return 1
`;

// First boot: seed Redis from the database, which is the source of truth.
// The Lua guard means only one replica wins if several start at once.
export async function ensureSale(redis: Redis, pool: Pool): Promise<Sale> {
  const existing = await readSale(redis);
  if (existing) return existing;
  const { rows } = await pool.query<{ stock: number }>(
    'SELECT stock FROM inventory WHERE product_id = $1',
    [config.productId],
  );
  if (rows.length === 0) throw new Error(`No inventory row for product ${config.productId}`);
  const saleId = newSaleId();
  await redis.eval(
    INIT_SALE_LUA, 2, SALE_KEY, saleKeys(saleId).stock,
    saleId, config.productId, String(todaysSaleTime()), String(config.initialStock), String(rows[0].stock),
  );
  return (await readSale(redis))!;
}
