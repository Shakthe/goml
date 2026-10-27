// Oversell Lab: the same burst against one checkout strategy (set STRATEGY).
// run-lab.sh runs it for all four and writes a comparison table.
import { check } from 'k6';
import exec from 'k6/execution';
import { SharedArray } from 'k6/data';
import { Counter } from 'k6/metrics';
import { checkout, randomIp, settledStats, startSale, tokenFor, uuid } from './lib.js';

const STRATEGY = __ENV.STRATEGY || 'queue';
const STOCK = Number(__ENV.STOCK || 500);
const BUYERS_N = Number(__ENV.BUYERS || 5000);

const byStatus = {
  ok: new Counter('lab_accepted'),
  soldOut: new Counter('lab_sold_out'),
  conflict: new Counter('lab_conflict'),
  errors: new Counter('lab_errors'),
};

const BUYERS = new SharedArray('buyers', () => {
  const out = [];
  for (let i = 0; i < BUYERS_N; i++) {
    const id = uuid();
    out.push({ id, token: tokenFor(id), key: id.replace(/-/g, ''), ip: randomIp() });
  }
  return out;
});

export const options = {
  discardResponseBodies: false,
  scenarios: {
    stampede: { executor: 'shared-iterations', vus: 200, iterations: BUYERS_N, maxDuration: '120s' },
  },
};

export function setup() {
  startSale(STOCK, STRATEGY, 0);
}

export default function () {
  const b = BUYERS[exec.scenario.iterationInTest];
  const res = checkout(b.id, b.ip, b.key, { strategy: STRATEGY }, b.token);
  if (res.status === 200 || res.status === 202) byStatus.ok.add(1);
  else if (res.status === 409 && res.body && res.body.includes('SOLD_OUT')) byStatus.soldOut.add(1);
  else if (res.status === 409) byStatus.conflict.add(1);
  else byStatus.errors.add(1);
}

export function teardown() {
  const s = settledStats();
  console.log(`LAB ${JSON.stringify({ strategy: STRATEGY, stock: STOCK, buyers: BUYERS_N, confirmedOrders: s.confirmedOrders, dbStock: s.dbStock })}`);
  check(s, { 'never oversells': (x) => x.confirmedOrders <= STOCK });
}
