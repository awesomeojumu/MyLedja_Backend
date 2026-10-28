import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newWorkspace, startTestApp, type TestApp } from '../../../../test/helpers/test-app.js';

let t: TestApp;
beforeAll(async () => {
  t = await startTestApp();
});
afterAll(() => t.close());

describe('goals (B2.4)', () => {
  it('creates a goal and allocates on the same account', async () => {
    const w = await newWorkspace(t);
    const s = t.services;
    const bank = await s.accounts.create(
      w.ctx,
      { type: 'bank', name: 'GTBank', openingBalance: '10000000', openingDate: '2026-10-01' } as never,
      uuidv7(),
    );
    const goal = await s.goals.create(
      w.ctx,
      { name: 'Laptop', targetAmount: '50000000', accountId: bank.id, targetDate: '2027-01-01' } as never,
      uuidv7(),
    );
    const { goal: updated } = await s.goals.allocate(
      w.ctx,
      goal.id,
      { date: '2026-10-15', amount: '5000000' } as never,
      uuidv7(),
    );
    expect(updated.savedAmount).toBe('5000000');
  });
});
