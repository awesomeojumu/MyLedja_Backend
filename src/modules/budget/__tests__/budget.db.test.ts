import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newWorkspace, startTestApp, type TestApp } from '../../../../test/helpers/test-app.js';

let t: TestApp;
beforeAll(async () => {
  t = await startTestApp();
});
afterAll(() => t.close());

async function world(style: 'envelope' | 'tracking' = 'envelope') {
  const w = await newWorkspace(t);
  const s = t.services;
  await t.db.collection('workspaces').updateOne({ _id: w.workspaceId as never }, { $set: { budgetStyle: style } });
  const bank = await s.accounts.create(
    w.ctx,
    { type: 'bank', name: 'GTBank', openingBalance: '10000000', openingDate: '2026-10-01' } as never,
    uuidv7(),
  );
  const tree = await s.categories.tree(w.ctx);
  const other = tree.groups.find((g) => g.name === 'Other')!;
  const incomeGroup = tree.groups.find((g) => g.kind === 'income')!;
  const food = await s.categories.create(w.ctx, { groupId: other.id, name: 'Food' } as never);
  const salary =
    tree.categories.find((c) => c.starterKey === 'other_income') ??
    (await s.categories.create(w.ctx, { groupId: incomeGroup.id, name: 'Salary', budgetable: true } as never));
  const spend = (amount: string, date: string, categoryId = food.id) =>
    s.transactions.create(w.ctx, { type: 'expense', accountId: bank.id, categoryId, amount, date } as never, uuidv7());
  const earn = (amount: string, date: string) =>
    s.transactions.create(
      w.ctx,
      { type: 'income', accountId: bank.id, categoryId: salary.id, amount, date } as never,
      uuidv7(),
    );
  return { ...w, s, bank, food, salary, spend, earn };
}

describe('budget (B1.9)', () => {
  it('envelope overspend drains next month left_to_plan (case 23)', async () => {
    const w = await world('envelope');
    await w.earn('50000000', '2026-10-25');
    await w.spend('9300000', '2026-10-27');
    await w.earn('50000000', '2026-11-25');
    await w.s.budget.assign(w.ctx, '2026-10', w.food.id, { assigned: '9000000' });
    await w.s.budget.assign(w.ctx, '2026-11', w.food.id, { assigned: '9000000' });

    const { months } = await w.s.budget.get(w.ctx, '2026-11', 2);
    expect(months).toHaveLength(2);
    const oct = months[0]!;
    const nov = months[1]!;
    expect(oct.month).toBe('2026-10');
    expect(oct.leftToPlan).toBe('41000000');
    expect(oct.overspentFromLastMonth).toBe('0');
    const foodOct = oct.categories.find((c) => c.categoryId === w.food.id)!;
    expect(foodOct).toMatchObject({
      carried: '0',
      assigned: '9000000',
      activity: '9300000',
      available: '-300000',
      state: 'over_plan',
    });
    expect(nov.overspentFromLastMonth).toBe('300000');
    expect(nov.leftToPlan).toBe('81700000');
    const foodNov = nov.categories.find((c) => c.categoryId === w.food.id)!;
    expect(foodNov).toMatchObject({
      carried: '0',
      assigned: '9000000',
      activity: '0',
      available: '9000000',
      state: 'within_plan',
    });
  });

  it('envelope carry-over across three months', async () => {
    const w = await world('envelope');
    await w.earn('30000000', '2026-08-01');
    await w.earn('30000000', '2026-09-01');
    await w.earn('30000000', '2026-10-01');
    await w.s.budget.assign(w.ctx, '2026-08', w.food.id, { assigned: '10000000' });
    await w.s.budget.assign(w.ctx, '2026-09', w.food.id, { assigned: '5000000' });
    await w.s.budget.assign(w.ctx, '2026-10', w.food.id, { assigned: '2000000' });
    await w.spend('4000000', '2026-08-15');
    await w.spend('1000000', '2026-09-15');
    // Aug available 6m carries; Sep 6+5-1=10m carries; Oct 10+2-0=12m.
    const { months } = await w.s.budget.get(w.ctx, '2026-10', 3);
    expect(months.map((m) => m.month)).toEqual(['2026-08', '2026-09', '2026-10']);
    expect(months[0]!.categories.find((c) => c.categoryId === w.food.id)).toMatchObject({
      carried: '0',
      available: '6000000',
    });
    expect(months[1]!.categories.find((c) => c.categoryId === w.food.id)).toMatchObject({
      carried: '6000000',
      available: '10000000',
    });
    expect(months[2]!.categories.find((c) => c.categoryId === w.food.id)).toMatchObject({
      carried: '10000000',
      available: '12000000',
    });
  });

  it('tracking does not carry leftover unless carryOver is on', async () => {
    const w = await world('tracking');
    await w.earn('20000000', '2026-10-01');
    await w.s.budget.assign(w.ctx, '2026-10', w.food.id, { assigned: '8000000', carryOver: false });
    await w.spend('3000000', '2026-10-10');
    await w.s.budget.assign(w.ctx, '2026-11', w.food.id, { assigned: '5000000' });

    const { months } = await w.s.budget.get(w.ctx, '2026-11', 2);
    const oct = months[0]!.categories.find((c) => c.categoryId === w.food.id)!;
    const nov = months[1]!.categories.find((c) => c.categoryId === w.food.id)!;
    expect(oct.available).toBe('5000000');
    expect(oct.carryOver).toBe(false);
    expect(nov.carried).toBe('0');
    expect(nov.available).toBe('5000000');
    expect(months[0]!.leftToPlan).toBeNull();
    expect(months[1]!.leftToPlan).toBeNull();
  });

  it('move and cover shift assigned amounts', async () => {
    const w = await world('envelope');
    const tree = await w.s.categories.tree(w.ctx);
    const other = tree.groups.find((g) => g.name === 'Other')!;
    const household = await w.s.categories.create(w.ctx, { groupId: other.id, name: 'Household' } as never);
    await w.earn('50000000', '2026-10-01');
    await w.s.budget.assign(w.ctx, '2026-10', w.food.id, { assigned: '10000000' });
    await w.s.budget.assign(w.ctx, '2026-10', household.id, { assigned: '2000000' });
    await w.spend('12000000', '2026-10-05'); // food over by 2m

    const covered = await w.s.budget.cover(w.ctx, '2026-10', {
      covers: [{ categoryId: w.food.id, fromCategoryId: household.id, amount: '2000000' }],
    });
    expect(covered.categories.find((c) => c.categoryId === w.food.id)!.assigned).toBe('12000000');
    expect(covered.categories.find((c) => c.categoryId === household.id)!.assigned).toBe('0');

    await w.s.budget.assign(w.ctx, '2026-10', household.id, { assigned: '3000000' });
    const moved = await w.s.budget.move(w.ctx, '2026-10', {
      fromCategoryId: household.id,
      toCategoryId: w.food.id,
      amount: '1000000',
    });
    expect(moved.categories.find((c) => c.categoryId === household.id)!.assigned).toBe('2000000');
    expect(moved.categories.find((c) => c.categoryId === w.food.id)!.assigned).toBe('13000000');
  });
});
