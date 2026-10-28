// Fails if test/fixtures/ledger-cases.json doesn't match test/fixtures/ledger-cases.sha256.
// When a sibling frontend checkout is present, also fails if the two repos' case files differ
// (BUILD-PLAN 1.3 / TECH-SPEC 6.12). Set LEDGER_CASES_SIBLING to override the sibling path.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const cases = resolve(root, 'test/fixtures/ledger-cases.json');
const sum = resolve(root, 'test/fixtures/ledger-cases.sha256');
const sibling =
  process.env.LEDGER_CASES_SIBLING ??
  resolve(root, '../myledja_frontend/test/fixtures/ledger-cases.json');

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
console.log(`cases:check: ledger cases match (${actual}).`);

if (existsSync(sibling)) {
  const other = createHash('sha256').update(readFileSync(sibling)).digest('hex');
  if (other !== actual) {
    console.error(
      `cases:check: cross-repo drift: this repo ${actual}, sibling ${other}. Copy the same ledger-cases.json and .sha256 to both repos (BUILD-PLAN 1.3).`,
    );
    process.exit(1);
  }
  console.log('cases:check: sibling frontend fixture matches.');
} else {
  console.log('cases:check: no sibling frontend fixture at', sibling, '(skip cross-repo compare).');
}
