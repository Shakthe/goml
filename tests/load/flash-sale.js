// The 8 PM scenario: 100,000 checkout requests for 500 units, as fast as possible,
// plus a bot hammering from a single IP. Pass criteria:
//   - every request gets an answer (no timeouts, no connection errors, no 5xx)
//   - exactly 500 orders in the database, stock 0 in both Redis and Postgres
//   - the bot is rate limited
import { check } from 'k6';
import { Counter, Rate } from 'k6/metrics';
import { SharedArray } from 'k6/data';
import exec from 'k6/execution';
import { checkout, randomIp, settledStats, startSale, tokenFor, uuid } from './lib.js';

const STOCK = Number(__ENV.STOCK || 500);
const TOTAL = Number(__ENV.TOTAL || 100000); // checkout requests to send

const accepted = new Counter('checkout_accepted_202');
const soldOut = new Counter('checkout_sold_out_409');
const rateLimited = new Counter('checkout_rate_limited_429');
const serverErrors = new Counter('checkout_server_errors_5xx');
const noResponse = new Counter('checkout_no_response');
const answered = new Rate('checkout_answered');
const botBlocked = new Rate('bot_requests_blocked');

export const options = {
  discardResponseBodies: true,
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)', 'p(99.9)'],
  scenarios: {
    buyers: {
      // 100,000 checkout requests, each from a different customer and client IP, sent as
      // fast as the machine allows with 100 requests in flight. Throughput is the same as
      // with 1,200 in flight (the CPU is the limit), but requests no longer queue behind
      // each other, so latency is far lower. Set VUS to change it.
      executor: 'shared-iterations',
      exec: 'buyer',
      vus: Number(__ENV.VUS || 100),
      iterations: TOTAL,
      maxDuration: '90s',
    },
    bot: {
      executor: 'constant-arrival-rate',
      exec: 'bot',
      rate: 100,
      timeUnit: '1s',
      duration: '10s',
      preAllocatedVUs: 20,
    },
  },
  thresholds: {
    checkout_answered: ['rate==1'],
    checkout_server_errors_5xx: ['count==0'],
    checkout_no_response: ['count==0'],
    'http_req_duration{scenario:buyers}': ['p(95)<100', 'p(99.9)<100'],
    bot_requests_blocked: ['rate>0.9'],
    'checks{phase:final}': ['rate==1'],
  },
};

// Pre-build every buyer (id, signed token, client IP) once, so the load generator
// spends its CPU sending requests rather than hashing.
const BUYERS = new SharedArray('buyers', () => {
  const out = [];
  for (let i = 0; i < 120000; i++) {
    const id = uuid();
    out.push({ id, token: tokenFor(id), key: id.replace(/-/g, ''), ip: randomIp() });
  }
  return out;
});

export function setup() {
  startSale(STOCK, 'queue', 0);
}

export function buyer() {
  const b = BUYERS[exec.scenario.iterationInTest % BUYERS.length];
  const res = checkout(b.id, b.ip, b.key, { kind: 'buyer' }, b.token);
  answered.add(res.status !== 0);
  if (res.status === 0) noResponse.add(1);
  else if (res.status === 202) accepted.add(1);
  else if (res.status === 409) soldOut.add(1);
  else if (res.status === 429) rateLimited.add(1);
  else if (res.status >= 500) serverErrors.add(1);
}

const BOT_IP = '100.99.99.99';
const BOT_USER = '00000000-0000-4000-a000-00000000b07b';
export function bot() {
  const res = checkout(BOT_USER, BOT_IP, 'bot-key-0001', { kind: 'bot' });
  botBlocked.add(res.status === 429);
}

export function teardown() {
  const s = settledStats();
  console.log(`FINAL confirmedOrders=${s.confirmedOrders} dbStock=${s.dbStock} redisStock=${s.redisStock} queue=${JSON.stringify(s.queue)} codes=${JSON.stringify(s.responseCodes)} instances=${JSON.stringify(s.requestsByInstance)} workers=${JSON.stringify(s.ordersByWorker)}`);
  check(s, {
    [`exactly ${STOCK} confirmed orders`]: (x) => x.confirmedOrders === STOCK,
    'database stock is 0': (x) => x.dbStock === 0,
    'redis stock is 0': (x) => x.redisStock === 0,
    'queue drained, nothing dead-lettered': (x) => x.queue.depth === 0 && x.queue.deadLetters === 0,
  }, { phase: 'final' });
}
