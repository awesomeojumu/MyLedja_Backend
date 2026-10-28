import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newWorkspace, startTestApp, type TestApp } from '../../../../test/helpers/test-app.js';

let t: TestApp;
beforeAll(async () => {
  t = await startTestApp();
});
afterAll(() => t.close());

describe('goals E19 spend (B2.4 / P06-08)', () => {
  it('spending from a goal does not overspend the category and lowers the earmark', async () => {
    const w = await newWorkspace(t);
    const s = t.services;
    await t.db
      .collection('workspaces')
      .updateOne({ _id: w.workspaceId as never }, { $set: { budgetStyle: 'envelope' } });
    const bank = await s.accounts.create(
      w.ctx,
      { type: 'bank', name: 'GTBank', openingBalance: '20000000', openingDate: '2026-10-01' } as never,
      uuidv7(),
    );
    const tree = await s.categories.tree(w.ctx);
    const other = tree.groups.find((g) => g.name === 'Other')!;
    const incomeGroup = tree.groups.find((g) => g.kind === 'income')!;
    const food = await s.categories.create(w.ctx, { groupId: other.id, name: 'Food' } as never);
    const salary =
      tree.categories.find((c) => c.starterKey === 'other_income') ??
      (await s.categories.create(w.ctx, { groupId: incomeGroup.id, name: 'Salary', budgetable: true } as never));

    await s.transactions.create(
      w.ctx,
      { type: 'income', accountId: bank.id, categoryId: salary.id, amount: '50000000', date: '2026-10-02' } as never,
      uuidv7(),
    );
    await s.budget.assign(w.ctx, '2026-10', food.id, { assigned: '5000000' });

    const goal = await s.goals.create(
      w.ctx,
      { name: 'Laptop', targetAmount: '10000000', accountId: bank.id, categoryId: food.id } as never,
      uuidv7(),
    );
    await s.goals.allocate(w.ctx, goal.id, { date: '2026-10-05', amount: '8000000' } as never, uuidv7());

    const spent = await s.goals.spend(
      w.ctx,
      goal.id,
      { date: '2026-10-20', amount: '3000000', categoryId: food.id, accountId: bank.id } as never,
      uuidv7(),
    );
    expect(spent.goal.savedAmount).toBe('5000000');
    expect(spent.allocation.kind).toBe('spend');

    const { transaction } = await s.transactions.get(w.ctx, spent.transactionId);
    expect(transaction.links.goalId).toBe(goal.id);
    expect(transaction.type).toBe('expense');

    const { months } = await s.budget.get(w.ctx, '2026-10', 1);
    const oct = months[0]!;
    const foodRow = oct.categories.find((c) => c.categoryId === food.id)!;
    expect(foodRow.activity).toBe('0');
    expect(foodRow.available).toBe('5000000');
    expect(foodRow.state).toBe('within_plan');
    // left_to_plan = 50m income − 5m assigned − 8m goal earmark = 37m
    expect(oct.leftToPlan).toBe('37000000');
  });
});
