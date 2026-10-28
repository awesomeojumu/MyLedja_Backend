// Fails if test/fixtures/ledger-cases.json doesn't match test/fixtures/ledger-cases.sha256.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const cases = resolve(root, 'test/fixtures/ledger-cases.json');
const sum = resolve(root, 'test/fixtures/ledger-cases.sha256');

if (!existsSync(cases) && !existsSync(sum)) {
  console.log('cases:check: no ledger cases yet (they arrive in Phase 1).');
  process.exit(0);
}
if (!existsSync(cases) || !existsSync(sum)) {
  console.error('cases:check: ledger-cases.json and ledger-cases.sha256 must both exist.');
  process.exit(1);
}
const actual = createHash('sha256').update(readFileSync(cases)).digest('hex');
const expected = readFileSync(sum, 'utf8').trim().split(/\s+/)[0];
if (actual !== expected) {
  console.error('cases:check: ledger-cases.json does not match its sha256.');
  process.exit(1);
}
console.log('cases:check: ledger cases match.');
