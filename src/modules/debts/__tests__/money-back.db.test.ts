import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newWorkspace, startTestApp, type TestApp } from '../../../../test/helpers/test-app.js';

let t: TestApp;
beforeAll(async () => {
  t = await startTestApp();
});
afterAll(() => t.close());

describe('money back (B2.6)', () => {
  it('suggests payee match and confirms as collect (case 26)', async () => {
    const w = await newWorkspace(t);
    const s = t.services;
    const opay = await s.accounts.create(
      w.ctx,
      { type: 'wallet', name: 'OPay', openingBalance: '10000000', openingDate: '2026-10-01' } as never,
      uuidv7(),
    );
    const debt = await s.debts.lend(
      w.ctx,
      { personName: 'Tunde', amount: '10000000', accountId: opay.id, date: '2026-10-01' } as never,
      uuidv7(),
    );
    const tree = await s.categories.tree(w.ctx);
    const incomeGroup = tree.groups.find((g) => g.name === 'Income')!;
    const salary =
      tree.categories.find((c) => c.kind === 'income' && c.name === 'Salary') ??
      (await s.categories.create(w.ctx, { groupId: incomeGroup.id, name: 'Salary', kind: 'income' } as never));
    const wrong = await s.transactions.create(
      w.ctx,
      {
        type: 'income',
        accountId: opay.id,
        categoryId: salary.id,
        amount: '4000000',
        date: '2026-10-20',
        payeeId: debt.payeeId,
      } as never,
      uuidv7(),
    );
    const { suggestions } = await s.debts.listMoneyBackSuggestions(w.ctx, { transactionId: wrong.id });
    expect(suggestions.length).toBeGreaterThan(0);
    const confirmed = await s.debts.confirmMoneyBack(w.ctx, suggestions[0]!.id, { choice: 'money_back' }, uuidv7());
    expect(confirmed.debt!.outstanding).toBe('6000000');
  });

  it('confirm as income leaves debt unchanged (case 27)', async () => {
    const w = await newWorkspace(t);
    const s = t.services;
    const opay = await s.accounts.create(
      w.ctx,
      { type: 'wallet', name: 'OPay', openingBalance: '10000000', openingDate: '2026-10-01' } as never,
      uuidv7(),
    );
    const debt = await s.debts.lend(
      w.ctx,
      { personName: 'Tunde', amount: '10000000', accountId: opay.id, date: '2026-10-01' } as never,
      uuidv7(),
    );
    const tree = await s.categories.tree(w.ctx);
    const incomeGroup = tree.groups.find((g) => g.name === 'Income')!;
    const salary =
      tree.categories.find((c) => c.kind === 'income' && c.name === 'Salary') ??
      (await s.categories.create(w.ctx, { groupId: incomeGroup.id, name: 'Salary', kind: 'income' } as never));
    const { suggestions } = await s.debts.listMoneyBackSuggestions(w.ctx, {
      payeeId: debt.payeeId,
      amount: '4000000',
      date: '2026-10-20',
      accountId: opay.id,
    });
    const confirmed = await s.debts.confirmMoneyBack(
      w.ctx,
      suggestions[0]!.id,
      { choice: 'income', categoryId: salary.id },
      uuidv7(),
    );
    expect(confirmed.debt!.outstanding).toBe('10000000');
    expect(confirmed.transaction.type).toBe('income');
  });
});
