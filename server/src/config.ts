// All runtime settings come from the environment so every replica is identical and stateless.
function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number, got "${raw}"`);
  return n;
}

function str(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`Missing required env var ${name}`);
  return v;
}

export const config = {
  port: num('PORT', 3000),
  databaseUrl: str('DATABASE_URL', 'postgres://flash:flash@localhost:5432/flash'),
  dbPoolSize: num('DB_POOL_SIZE', 10),
  redisUrl: str('REDIS_URL', 'redis://localhost:6379'),
  amqpUrl: str('AMQP_URL', 'amqp://flash:flash@localhost:5672'),
  sessionSecret: str('SESSION_SECRET', 'dev-only-session-secret'),
  adminToken: str('ADMIN_TOKEN', 'dev-admin-token'),
  productId: str('PRODUCT_ID', 'nova-x1'),
  initialStock: num('INITIAL_STOCK', 500),
  // Sale opens at this local time each day unless an admin schedules a demo sale.
  saleHour: num('SALE_HOUR', 20),
  saleTimezoneOffsetMinutes: num('SALE_TZ_OFFSET_MINUTES', 330), // IST
  workerPrefetch: num('WORKER_PREFETCH', 1),
};

export const QUEUE = 'checkout.orders';
export const DEAD_LETTER_QUEUE = 'checkout.orders.dead';
