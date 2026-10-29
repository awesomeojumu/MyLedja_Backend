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

  it('markOneOff persists oneOff so unmatched / steadiness skip it', async () => {
    const w = await newWorkspace(t);
    const s = t.services;
    const bank = await s.accounts.create(
      w.ctx,
      { type: 'bank', name: 'GTBank', openingBalance: '0', openingDate: '2026-10-01' } as never,
      uuidv7(),
    );
    const tree = await s.categories.tree(w.ctx);
    const salary = tree.categories.find((c) => c.kind === 'income')!;
    const tx = await s.transactions.create(
      w.ctx,
      {
        type: 'income',
        accountId: bank.id,
        categoryId: salary.id,
        amount: '5000000',
        date: '2026-10-15',
      } as never,
      uuidv7(),
    );
    const marked = await s.income.markOneOff(w.ctx, tx.id);
    expect(marked.oneOff).toBe(true);
    const month = await s.income.getMonth(w.ctx, '2026-10');
    expect(month.unmatched.find((u) => u.transaction.id === tx.id)).toBeUndefined();
  });

  it('mark-received on a gross stream posts salary_gross (E24 / case 18)', async () => {
    const w = await newWorkspace(t);
    const s = t.services;
    const bank = await s.accounts.create(
      w.ctx,
      { type: 'bank', name: 'GTBank', openingBalance: '0', openingDate: '2026-10-01' } as never,
      uuidv7(),
    );
    const pension = await s.accounts.create(
      w.ctx,
      { type: 'pension', name: 'RSA', openingBalance: '0', openingDate: '2026-10-01' } as never,
      uuidv7(),
    );
    const nhf = await s.accounts.create(
      w.ctx,
      { type: 'other_asset', name: 'NHF', openingBalance: '0', openingDate: '2026-10-01' } as never,
      uuidv7(),
    );
    const tree = await s.categories.tree(w.ctx);
    const salary = tree.categories.find((c) => c.kind === 'income')!;
    await s.income.createStream(
      w.ctx,
      {
        name: 'Gross salary',
        streamKind: 'regular',
        accountId: bank.id,
        categoryId: salary.id,
        amount: '62000000',
        recurrence: { every: 1, unit: 'month', dayOfMonth: 25, weekday: null },
        startDate: '2026-10-01',
        taxClass: 'paye',
        recordAs: 'gross',
        grossAmount: '80000000',
        deductions: [
          { label: 'PAYE', amount: '9600000' },
          { label: 'Pension', amount: '6400000', ledgerAccountId: pension.id },
          { label: 'NHF', amount: '2000000', ledgerAccountId: nhf.id },
        ],
      } as never,
      uuidv7(),
    );
    const { occurrences, schedules } = await s.schedules.listOccurrences(w.ctx, '2026-10');
    const incomeSched = schedules.find((x) => x.kind === 'income' && x.name === 'Gross salary');
    expect(incomeSched).toBeTruthy();
    const occ = occurrences.find((o) => o.scheduleId === incomeSched!.id);
    expect(occ).toBeTruthy();
    const result = await s.schedules.markReceived(
      w.ctx,
      occ!.id,
      { create: { date: '2026-10-25', amount: '62000000' } },
      uuidv7(),
    );
    expect(result.transaction?.type).toBe('salary_gross');
  });
});
