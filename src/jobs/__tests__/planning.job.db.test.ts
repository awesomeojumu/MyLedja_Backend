import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { memberContext } from '../../common/workspace/workspace-context.js';
import { newWorkspace, startTestApp, type TestApp } from '../../../test/helpers/test-app.js';

let t: TestApp;
beforeAll(async () => {
  t = await startTestApp();
});
afterAll(() => t.close());

describe('planning jobs (B2.2)', () => {
  it('delivers a bill reminder once on the chosen local day', async () => {
    const w = await newWorkspace(t);
    const s = t.services;
    const ownerEmail = `owner.${w.userId.slice(0, 8)}@example.test`;
    const now = new Date();
    await t.db.collection('users').insertOne({
      _id: w.userId,
      email: ownerEmail,
      name: 'Owner',
      passwordHash: 'x',
      googleId: null,
      emailVerifiedAt: now,
      termsAcceptedAt: now,
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
      version: 1,
    } as never);
    const bank = await s.accounts.create(
      w.ctx,
      { type: 'bank', name: 'GTBank', openingBalance: '5000000', openingDate: '2026-10-01' } as never,
      uuidv7(),
    );
    const tree = await s.categories.tree(w.ctx);
    const food =
      tree.categories.find((c) => c.name === 'Food') ??
      (await s.categories.create(w.ctx, { groupId: tree.groups[0]!.id, name: 'Food' } as never));
    await s.schedules.create(
      w.ctx,
      {
        kind: 'bill',
        name: 'Rent',
        accountId: bank.id,
        categoryId: food.id,
        amount: '12000000',
        recurrence: { every: 1, unit: 'month', dayOfMonth: 28, weekday: null },
        startDate: '2026-10-01',
        reminder: { daysBefore: ['1'], hideAmountOnLockScreen: true },
      } as never,
      uuidv7(),
    );
    // 2026-10-27 08:00 in Africa/Lagos (UTC+1).
    t.clock.now = new Date('2026-10-27T07:00:00.000Z');
    const emailsBefore = t.outbox.messages.length;
    await s.schedules.deliverReminders(w.ctx, { localDate: '2026-10-27', ownerUserId: w.userId });
    const listCtx = memberContext({
      workspaceId: w.workspaceId,
      userId: w.userId,
      sessionId: null,
      role: 'owner',
    });
    const first = await s.notifications.list(listCtx, { limit: 10 });
    expect(first.items).toHaveLength(1);
    expect(first.items[0]).toMatchObject({ kind: 'bill', title: 'Rent due tomorrow', amount: null });
    const reminders = t.outbox.messages.slice(emailsBefore).filter((m) => m.template === 'bill_reminder');
    expect(reminders).toHaveLength(1);
    expect(reminders[0]).toMatchObject({ to: ownerEmail, subject: 'Rent due tomorrow' });
    await s.schedules.deliverReminders(w.ctx, { localDate: '2026-10-27', ownerUserId: w.userId });
    const second = await s.notifications.list(listCtx, { limit: 10 });
    expect(second.items).toHaveLength(1);
    expect(t.outbox.messages.slice(emailsBefore).filter((m) => m.template === 'bill_reminder')).toHaveLength(1);
  });

  it('bill-reminders job creates inbox rows without duplicate stubs', async () => {
    const w = await newWorkspace(t);
    const s = t.services;
    const bank = await s.accounts.create(
      w.ctx,
      { type: 'bank', name: 'Power', openingBalance: '100000', openingDate: '2026-10-01' } as never,
      uuidv7(),
    );
    const tree = await s.categories.tree(w.ctx);
    const util = tree.categories.find((c) => c.name === 'Utilities') ?? tree.categories[0]!;
    await s.schedules.create(
      w.ctx,
      {
        kind: 'bill',
        name: 'NEPA',
        accountId: bank.id,
        categoryId: util.id,
        amount: '450000',
        recurrence: { every: 1, unit: 'month', dayOfMonth: 15, weekday: null },
        startDate: '2026-10-01',
        reminder: { daysBefore: ['0'], hideAmountOnLockScreen: false },
      } as never,
      uuidv7(),
    );
    t.clock.now = new Date('2026-10-15T06:30:00.000Z'); // 07:30 Lagos on due day
    await s.jobs.schedule();
    let notifications = 0;
    for (let i = 0; i < 30 && notifications === 0; i++) {
      await s.jobs.tick();
      notifications = await t.db.collection('notifications').countDocuments({ workspaceId: w.workspaceId });
    }
    expect(notifications).toBe(1);
    const listCtx = memberContext({
      workspaceId: w.workspaceId,
      userId: w.userId,
      sessionId: null,
      role: 'owner',
    });
    const page = await s.notifications.list(listCtx, { limit: 5 });
    expect(page.items[0]?.title).toBe('NEPA due today');
  });

  it('recurring-daily auto-posts when autoPost is enabled at local midnight', async () => {
    const w = await newWorkspace(t);
    const s = t.services;
    const bank = await s.accounts.create(
      w.ctx,
      { type: 'bank', name: 'Cash', openingBalance: '1000000', openingDate: '2026-10-01' } as never,
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
        kind: 'bill',
        name: 'Lunch sub',
        accountId: bank.id,
        categoryId: food.id,
        amount: '500000',
        recurrence: { every: 1, unit: 'month', dayOfMonth: 16, weekday: null },
        startDate: '2026-10-01',
        autoPost: true,
      } as never,
      uuidv7(),
    );
    t.clock.now = new Date('2026-10-16T05:05:00.000Z'); // 06:05 Lagos, within midnight window
    const posted = await s.schedules.autoPostDueOccurrences(w.ctx, '2026-10-16');
    expect(posted).toBe(1);
    const { occurrences } = await s.schedules.listOccurrences(w.ctx, '2026-10');
    const occ = occurrences.find((o) => o.date === '2026-10-16');
    expect(occ?.status).toBe('paid');
    expect(occ?.matchedTransactionId).toBeTruthy();
  });
});
