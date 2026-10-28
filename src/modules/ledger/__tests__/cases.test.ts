import { describe, it } from 'vitest';
import { loadCases, memoryEngine, runCase } from '../../../../test/helpers/ledger-cases.js';

const file = loadCases();

describe('ledger cases, pure builders and read formulas (B1.5)', () => {
  for (const c of file.cases) {
    it(`case ${c.id}: ${c.title}`, async () => {
      await runCase(c, file, memoryEngine(file));
    });
  }
});
