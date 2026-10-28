import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newWorkspace, startTestApp, type TestApp } from '../../../../test/helpers/test-app.js';

let t: TestApp;
beforeAll(async () => {
  t = await startTestApp();
});
afterAll(() => t.close());

describe('income (B2.3)', () => {
  it('creates a stream and reads month summary', async () => {
    const w = await newWorkspace(t);
    const s = t.services;
    const bank = await s.accounts.create(
      w.ctx,
      { type: 'bank', name: 'GTBank', openingBalance: '0', openingDate: '2026-10-01' } as never,
      uuidv7(),
    );
    const tree = await s.categories.tree(w.ctx);
    const incomeGroup = tree.groups.find((g) => g.name === 'Income')!;
    const salary =
      tree.categories.find((c) => c.kind === 'income') ??
      (await s.categories.create(w.ctx, { groupId: incomeGroup.id, name: 'Salary', kind: 'income' } as never));
    await s.income.createStream(
      w.ctx,
      {
        name: 'Employer salary',
        streamKind: 'regular',
        accountId: bank.id,
        categoryId: salary.id,
        amount: '64000000',
        recurrence: { every: 1, unit: 'month', dayOfMonth: 25, weekday: null },
        startDate: '2026-10-01',
        taxClass: 'paye',
      } as never,
      uuidv7(),
    );
    const month = await s.income.getMonth(w.ctx, '2026-10');
    expect(month.streams.length).toBe(1);
    expect(month.summary.expected).toBe('64000000');
  });
});
