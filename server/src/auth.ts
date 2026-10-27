import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { config } from './config.js';

// A tiny signed session token: "<userId>.<signature>". No database lookup is needed
// to verify it, which keeps the checkout path free of extra queries.
function sign(userId: string): string {
  return createHmac('sha256', config.sessionSecret).update(userId).digest('base64url');
}

export function issueSession(): { userId: string; token: string } {
  const userId = randomUUID();
  return { userId, token: `${userId}.${sign(userId)}` };
}

export function verifySession(header: string | undefined): string | null {
  if (!header?.startsWith('Bearer ')) return null;
  const [userId, sig] = header.slice(7).split('.');
  if (!userId || !sig || userId.length > 64) return null;
  const expected = Buffer.from(sign(userId));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  return userId;
}

export function isAdmin(header: string | undefined): boolean {
  if (!header) return false;
  const a = Buffer.from(header);
  const b = Buffer.from(config.adminToken);
  return a.length === b.length && timingSafeEqual(a, b);
}
