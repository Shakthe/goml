import http from 'k6/http';
import crypto from 'k6/crypto';
import { sleep } from 'k6';

export const BASE = __ENV.BASE_URL || 'http://localhost:8080';
const SECRET = __ENV.SESSION_SECRET || 'dev-only-session-secret';
export const ADMIN = __ENV.ADMIN_TOKEN || 'dev-admin-token';
// For checkout, 409 (sold out) and 429 (rate limited) are correct answers, not failures.
const CHECKOUT_OK = http.expectedStatuses(200, 202, 409, 429);

// The load test signs its own session tokens with the shared dev secret, so every
// request in the test is a real checkout and none of the budget goes to sign-ups.
export function tokenFor(userId) {
  const sig = crypto.hmac('sha256', SECRET, userId, 'base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${userId}.${sig}`;
}

export function randomIp() {
  const r = () => Math.floor(Math.random() * 254) + 1;
  return `100.${64 + Math.floor(Math.random() * 64)}.${r()}.${r()}`;
}

export function uuid() {
  const h = crypto.randomBytes(16);
  const b = new Uint8Array(h);
  const hex = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function startSale(stock, strategy = 'queue', startsInSeconds = 0) {
  const res = http.post(`${BASE}/api/admin/sale`, JSON.stringify({ stock, startsInSeconds, strategy }), {
    headers: { 'Content-Type': 'application/json', 'X-Admin-Token': ADMIN, 'X-Forwarded-For': randomIp() },
    responseType: 'text',
  });
  if (res.status !== 200) throw new Error(`could not start sale: ${res.status} ${res.body}`);
  sleep(1.5); // let every API replica pick up the new sale
  return res.json();
}

export function stats() {
  return http.get(`${BASE}/api/stats`, { headers: { 'X-Forwarded-For': randomIp() }, responseType: 'text' }).json();
}

// Wait for the workers to drain the queue before checking the final numbers.
export function settledStats(timeoutSec = 60) {
  let s = stats();
  for (let i = 0; i < timeoutSec * 2 && s.queue.depth > 0; i++) {
    sleep(0.5);
    s = stats();
  }
  sleep(1);
  return stats();
}

export function checkout(userId, ip, idemKey, tags, token = tokenFor(userId)) {
  return http.post(`${BASE}/api/checkout`, '{}', {
    headers: {
      Authorization: `Bearer ${token}`,
      'Idempotency-Key': idemKey,
      'Content-Type': 'application/json',
      'X-Forwarded-For': ip,
      'User-Agent': 'k6-load-test',
    },
    timeout: '15s',
    tags,
    responseCallback: CHECKOUT_OK,
  });
}
