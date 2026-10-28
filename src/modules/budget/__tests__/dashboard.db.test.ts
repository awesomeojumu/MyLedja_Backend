import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newWorkspace, startTestApp, type TestApp } from '../../../../test/helpers/test-app.js';

let t: TestApp;
beforeAll(async () => {
  t = await startTestApp();
});
afterAll(() => t.close());

async function world() {
  const w = await newWorkspace(t);
  const s = t.services;
  await t.db.collection('workspaces').updateOne({ _id: w.workspaceId as never }, { $set: { budgetStyle: 'envelope' } });
  const bank = await s.accounts.create(
    w.ctx,
    { type: 'bank', name: 'GTBank', openingBalance: '10000000', openingDate: '2026-09-01' } as never,
    uuidv7(),
  );
  const wallet = await s.accounts.create(
    w.ctx,
    { type: 'wallet', name: 'OPay', openingBalance: '0', openingDate: '2026-09-01' } as never,
    uuidv7(),
  );
  const tree = await s.categories.tree(w.ctx);
  const other = tree.groups.find((g) => g.name === 'Other')!;
  const food = await s.categories.create(w.ctx, { groupId: other.id, name: 'Food' } as never);
  const salary = tree.categories.find((c) => c.starterKey === 'other_income')!;
  return { ...w, s, bank, wallet, food, salary };
}

describe('dashboard (B1.10)', () => {
  it('tiles come from period_totals; transfers do not affect income or spent', async () => {
    const w = await world();
    // October income + spend.
    await w.s.transactions.create(
      w.ctx,
      {
        type: 'income',
        accountId: w.bank.id,
        categoryId: w.salary.id,
        amount: '50000000',
        date: '2026-10-05',
      } as never,
      uuidv7(),
    );
    await w.s.transactions.create(
      w.ctx,
      {
        type: 'expense',
        accountId: w.bank.id,
        categoryId: w.food.id,
        amount: '8000000',
        date: '2026-10-10',
      } as never,
      uuidv7(),
    );
    // Transfer bank → wallet must not change Income or Spent (cases 3/7/9 shape).
    await w.s.transactions.create(
      w.ctx,
      {
        type: 'transfer',
        fromAccountId: w.bank.id,
        toAccountId: w.wallet.id,
        amount: '2000000',
        date: '2026-10-12',
      } as never,
      uuidv7(),
    );
    await w.s.budget.assign(w.ctx, '2026-10', w.food.id, { assigned: '10000000' });

    const dash = await w.s.budget.dashboard(w.ctx, '2026-10');
    expect(dash.month).toBe('2026-10');
    expect(dash.tiles.income.amount).toBe('50000000');
    expect(dash.tiles.spent.amount).toBe('8000000');
    expect(dash.tiles.netCash.amount).toBe('42000000');
    expect(dash.tiles.budgetLeft.amount).toBe('2000000');
    expect(dash.leftToSpend).toEqual({ amount: '2000000', planned: '10000000' });
    expect(dash.whereItWent.some((r) => r.categoryId === w.food.id && r.amount === '8000000')).toBe(true);
    expect(dash.recent.length).toBeGreaterThan(0);
    expect(dash.netWorth.series).toHaveLength(12);
    expect(dash.incomeVsSpending).toHaveLength(6);
    expect(dash.spendingByDay.length).toBe(31);
    expect(dash.spendingByDay[9]).toMatchObject({ day: 10, thisMonth: '8000000' });
    expect(dash.getStarted.hidden).toBe(false);
    expect(dash.getStarted.steps.find((s) => s.key === 'account')!.done).toBe(true);
    expect(dash.getStarted.steps.find((s) => s.key === 'transaction')!.done).toBe(true);
    expect(dash.getStarted.steps.find((s) => s.key === 'budget')!.done).toBe(true);
    expect(dash.getStarted.steps.find((s) => s.key === 'bill')!.done).toBe(false);

    // September was empty — lastMonth tiles are zero, change equals this month.
    expect(dash.tiles.income.lastMonth).toBe('0');
    expect(dash.tiles.income.change).toBe('50000000');
    expect(dash.tiles.spent.change).toBe('8000000');
  });

  it('loan and investment movements stay off income and spent', async () => {
    const w = await world();
    const loan = await w.s.accounts.create(
      w.ctx,
      { type: 'loan', name: 'Car loan', openingBalance: '50000000', openingDate: '2026-10-01' } as never,
      uuidv7(),
    );
    const investment = await w.s.accounts.create(
      w.ctx,
      { type: 'investment', name: 'Stocks', openingBalance: '0', openingDate: '2026-10-01' } as never,
      uuidv7(),
    );
    // Pay down the loan from the bank (transfer); buy into investment (transfer).
    await w.s.transactions.create(
      w.ctx,
      {
        type: 'transfer',
        fromAccountId: w.bank.id,
        toAccountId: loan.id,
        amount: '1000000',
        date: '2026-10-08',
      } as never,
      uuidv7(),
    );
    await w.s.transactions.create(
      w.ctx,
      {
        type: 'transfer',
        fromAccountId: w.bank.id,
        toAccountId: investment.id,
        amount: '500000',
        date: '2026-10-09',
      } as never,
      uuidv7(),
    );
    const dash = await w.s.budget.dashboard(w.ctx, '2026-10');
    expect(dash.tiles.income.amount).toBe('0');
    expect(dash.tiles.spent.amount).toBe('0');
    expect(dash.tiles.netCash.amount).toBe('0');
  });
});
