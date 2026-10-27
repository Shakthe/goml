// Builds a markdown comparison table from the k6 lab outputs.
import { readFileSync } from 'node:fs';

const rows = [];
for (const s of ['naive', 'pessimistic', 'optimistic', 'queue']) {
  const text = readFileSync(`evidence/k6/lab-${s}.txt`, 'utf8');
  const lab = JSON.parse(text.match(/LAB (\{.*\})/)[1].replace(/\\"/g, '"'));
  const sum = JSON.parse(readFileSync(`evidence/k6/lab-${s}.json`, 'utf8')).metrics;
  const d = sum.http_req_duration;
  const c = (name) => sum[name]?.count ?? 0;
  const oversold = lab.confirmedOrders - lab.stock;
  rows.push(`| ${s} | ${lab.buyers} | ${lab.stock} | ${lab.confirmedOrders} | ${oversold > 0 ? `**+${oversold}**` : '0'} | ${c('lab_conflict')} | ${c('lab_errors')} | ${d.med.toFixed(1)} | ${d['p(95)'].toFixed(1)} | ${d.max.toFixed(0)} | ${sum.http_reqs.rate.toFixed(0)} |`);
}
console.log(`| Strategy | Buyers | Units | Orders confirmed | Oversold | Conflicts (409) | Errors | Median ms | p95 ms | Max ms | Req/s |
|---|---|---|---|---|---|---|---|---|---|---|
${rows.join('\n')}`);
