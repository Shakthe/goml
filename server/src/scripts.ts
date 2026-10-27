// Redis runs each Lua script as one atomic step: no other command can interleave,
// so "check stock, then take one" can never race the way SELECT-then-UPDATE does.
// All keys share the {saleId} hash tag so the script also works on Redis Cluster.

/**
 * KEYS[1] stock counter    KEYS[2] buyers hash (userId -> orderId)
 * KEYS[3] idempotency hash KEYS[4] order hash
 * ARGV[1] userId  ARGV[2] orderId  ARGV[3] idempotencyKey  ARGV[4] createdAt  ARGV[5] ttlSeconds
 * Returns {status, orderId}
 */
export const RESERVE_LUA = `
local existing = redis.call('HGET', KEYS[3], ARGV[3])
if existing then return {'DUPLICATE', existing} end
existing = redis.call('HGET', KEYS[2], ARGV[1])
if existing then return {'ALREADY_PURCHASED', existing} end
local stock = tonumber(redis.call('GET', KEYS[1]) or '0')
if stock <= 0 then return {'SOLD_OUT', ''} end
redis.call('DECR', KEYS[1])
redis.call('HSET', KEYS[2], ARGV[1], ARGV[2])
redis.call('HSET', KEYS[3], ARGV[3], ARGV[2])
redis.call('HSET', KEYS[4], 'status', 'PENDING', 'userId', ARGV[1], 'createdAt', ARGV[4])
redis.call('EXPIRE', KEYS[4], tonumber(ARGV[5]))
return {'RESERVED', ARGV[2]}
`;

/**
 * Gives a reserved unit back. Used when the order could not be queued or the
 * database refused it. Only releases if this order still owns the reservation.
 * KEYS same as RESERVE_LUA. ARGV[1] userId ARGV[2] orderId ARGV[3] idempotencyKey ARGV[4] reason
 */
export const RELEASE_LUA = `
if redis.call('HGET', KEYS[2], ARGV[1]) ~= ARGV[2] then return 0 end
redis.call('HDEL', KEYS[2], ARGV[1])
redis.call('HDEL', KEYS[3], ARGV[3])
redis.call('INCR', KEYS[1])
redis.call('HSET', KEYS[4], 'status', 'FAILED', 'reason', ARGV[4])
return 1
`;
