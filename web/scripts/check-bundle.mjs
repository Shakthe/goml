// Fails the build if the JavaScript + CSS a shopper downloads goes over budget.
import { readdirSync, readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';

const BUDGET_KB = 200;
const dir = new URL('../dist/assets/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const files = readdirSync(dir).filter((f) => /\.(js|css)$/.test(f));
let raw = 0, gz = 0;
for (const f of files) {
  const buf = readFileSync(join(dir, f));
  raw += buf.length;
  gz += gzipSync(buf).length;
  console.log(`${f.padEnd(40)} ${(buf.length / 1024).toFixed(1).padStart(7)} KB  ${(gzipSync(buf).length / 1024).toFixed(1).padStart(6)} KB gz`);
}
console.log(`total: ${(raw / 1024).toFixed(1)} KB raw, ${(gz / 1024).toFixed(1)} KB gzipped (budget ${BUDGET_KB} KB raw)`);
if (raw / 1024 > BUDGET_KB) {
  console.error('Bundle is over budget.');
  process.exit(1);
}
