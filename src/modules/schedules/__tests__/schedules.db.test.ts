import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newWorkspace, startTestApp, type TestApp } from '../../../../test/helpers/test-app.js';

let t: TestApp;
beforeAll(async () => {
  t = await startTestApp();
});
afterAll(() => t.close());

describe('schedules (B2.1)', () => {
  it('creates a bill, lists occurrences, marks paid once', async () => {
    const w = await newWorkspace(t);
    const s = t.services;
    const bank = await s.accounts.create(
      w.ctx,
      { type: 'bank', name: 'GTBank', openingBalance: '5000000', openingDate: '2026-10-01' } as never,
      uuidv7(),
    );
    const tree = await s.categories.tree(w.ctx);
    const other = tree.groups.find((g) => g.name === 'Other')!;
    const food =
      tree.categories.find((c) => c.name === 'Food') ??
      (await s.categories.create(w.ctx, { groupId: other.id, name: 'Food' } as never));
    const schedule = await s.schedules.create(
      w.ctx,
      {
        kind: 'bill',
        name: 'Rent',
        accountId: bank.id,
        categoryId: food.id,
        amount: '12000000',
        recurrence: { every: 1, unit: 'month', dayOfMonth: 28, weekday: null },
        startDate: '2026-10-01',
      } as never,
      uuidv7(),
    );
    expect(schedule.name).toBe('Rent');
    const { occurrences } = await s.schedules.listOccurrences(w.ctx, '2026-10');
    expect(occurrences.some((o) => o.scheduleId === schedule.id && o.date === '2026-10-28')).toBe(true);
    const occ = occurrences.find((o) => o.date === '2026-10-28')!;
    const first = await s.schedules.markPaid(
      w.ctx,
      occ.id,
      { create: { date: '2026-10-28', amount: '12000000' } } as never,
      uuidv7(),
    );
    expect(first.occurrence.status).toBe('paid');
    await expect(
      s.schedules.markPaid(w.ctx, occ.id, { create: { date: '2026-10-28' } } as never, uuidv7()),
    ).rejects.toMatchObject({ code: 'already_paid' });
    const undone = await s.schedules.unmark(w.ctx, occ.id);
    expect(undone.occurrence.status).not.toBe('paid');
    expect(undone.occurrence.matchedTransactionId).toBeNull();
    // Composite scheduleId:date also works (FE sync key).
    await s.schedules.markPaid(
      w.ctx,
      `${schedule.id}:2026-10-28`,
      { create: { date: '2026-10-28', amount: '12000000' } } as never,
      uuidv7(),
    );
    const undoneComposite = await s.schedules.unmark(w.ctx, `${schedule.id}:2026-10-28`);
    expect(undoneComposite.occurrence.matchedTransactionId).toBeNull();
  });

  it('plan summary counts expected outflows', async () => {
    const w = await newWorkspace(t);
    const s = t.services;
    const bank = await s.accounts.create(
      w.ctx,
      { type: 'bank', name: 'GTBank', openingBalance: '0', openingDate: '2026-10-01' } as never,
      uuidv7(),
    );
    const tree = await s.categories.tree(w.ctx);
    const other = tree.groups.find((g) => g.name === 'Other')!;
    const food =
      tree.categories.find((c) => c.name === 'Food') ??
      (await s.categories.create(w.ctx, { groupId: other.id, name: 'Food' } as never));
    await s.schedules.create(
      w.ctx,
      {
        kind: 'subscription',
        name: 'Netflix',
        accountId: bank.id,
        categoryId: food.id,
        amount: '500000',
        recurrence: { every: 1, unit: 'month', dayOfMonth: 5, weekday: null },
        startDate: '2026-10-01',
      } as never,
      uuidv7(),
    );
    const summary = await s.schedules.planSummary(w.ctx, '2026-10');
    expect(summary.goingOut).toBe('500000');
  });
});
