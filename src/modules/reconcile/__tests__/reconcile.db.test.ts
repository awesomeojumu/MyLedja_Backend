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
  const bank = await s.accounts.create(
    w.ctx,
    { type: 'bank', name: 'GTBank', openingBalance: '10000000', openingDate: '2026-10-01' } as never,
    uuidv7(),
  );
  const tree = await s.categories.tree(w.ctx);
  const other = tree.groups.find((g) => g.name === 'Other')!;
  const food = await s.categories.create(w.ctx, { groupId: other.id, name: 'Food' } as never);
  const spend = (amount: string, date: string) =>
    s.transactions.create(
      w.ctx,
      { type: 'expense', accountId: bank.id, categoryId: food.id, amount, date } as never,
      uuidv7(),
    );
  return { ...w, s, bank, food, spend };
}

describe('reconcile (B1.13)', () => {
  it('ticks to a zero difference and locks (case 20 shape)', async () => {
    const w = await world();
    // Opening 10000000; spend 1500000 → balance 8500000.
    const tx = await w.spend('1500000', '2026-10-05');
    const start = await w.s.reconcile.start(w.ctx, w.bank.id, {
      statementDate: '2026-10-31',
      statementBalance: '8500000',
    });
    expect(start.reconciliation.status).toBe('in_progress');
    // Opening + expense must both be ticked to match statement.
    const opening = (await w.s.transactions.list(w.ctx, { type: ['opening_balance'], limit: 5 } as never)).items[0]!;
    const ticked = await w.s.reconcile.tick(w.ctx, start.reconciliation.id, {
      transactionIds: [opening.id, tx.id],
      cleared: true,
    });
    expect(ticked.reconciliation.difference).toBe('0');
    const finished = await w.s.reconcile.finish(w.ctx, start.reconciliation.id, { adjust: false }, uuidv7());
    expect(finished.reconciliation.status).toBe('finished');
    const locked = await w.s.transactions.get(w.ctx, tx.id);
    expect(locked.transaction.reconciled).toBe(true);
    await expect(
      w.s.transactions.correct(
        w.ctx,
        tx.id,
        {
          baseVersion: locked.transaction.version,
          input: {
            type: 'expense',
            accountId: w.bank.id,
            categoryId: w.food.id,
            amount: '1400000',
            date: '2026-10-05',
          },
        } as never,
        uuidv7(),
      ),
    ).rejects.toMatchObject({ code: 'reconciled' });
    const unlocked = await w.s.transactions.unlock(w.ctx, tx.id);
    expect(unlocked.reconciled).toBe(false);
    const hist = await w.s.reconcile.get(w.ctx, start.reconciliation.id);
    expect(hist.reconciliation.unlocked.some((u) => u.transactionId === tx.id)).toBe(true);
  });

  it('finishes with an E9 adjustment when asked (case 20)', async () => {
    const w = await world();
    const tx = await w.spend('100000', '2026-10-10');
    const start = await w.s.reconcile.start(w.ctx, w.bank.id, {
      statementDate: '2026-10-31',
      statementBalance: '9900000', // opening 10m − 100k = 9.9m, but we'll only tick the expense → need adjust
    });
    // Tick only the expense; cleared = -100000 shown on asset → difference large.
    // Better: tick opening+expense so cleared=9.9m, statement=9.85m, adjust -50k.
    const opening = (await w.s.transactions.list(w.ctx, { type: ['opening_balance'], limit: 5 } as never)).items[0]!;
    await w.s.reconcile.tick(w.ctx, start.reconciliation.id, {
      transactionIds: [opening.id, tx.id],
      cleared: true,
    });
    // Force a difference by using a statement that doesn't match.
    await t.db
      .collection('reconciliations')
      .updateOne({ _id: start.reconciliation.id as never }, { $set: { statementBalanceMinor: '9850000' } });
    const finished = await w.s.reconcile.finish(w.ctx, start.reconciliation.id, { adjust: true }, uuidv7());
    expect(finished.reconciliation.adjustmentId).toBeTruthy();
    expect(finished.reconciliation.difference).toBe('0');
    // Adjustment is equity, not income or spending — balances still add up.
    expect((await w.s.balanceCheck.check(w.ctx)).ok).toBe(true);
  });

  it('starting again returns the in-progress one; cancel keeps ticks', async () => {
    const w = await world();
    const a = await w.s.reconcile.start(w.ctx, w.bank.id, {
      statementDate: '2026-10-31',
      statementBalance: '10000000',
    });
    const b = await w.s.reconcile.start(w.ctx, w.bank.id, {
      statementDate: '2026-11-30',
      statementBalance: '0',
    });
    expect(b.reconciliation.id).toBe(a.reconciliation.id);
    const opening = (await w.s.transactions.list(w.ctx, { type: ['opening_balance'], limit: 5 } as never)).items[0]!;
    await w.s.reconcile.tick(w.ctx, a.reconciliation.id, { transactionIds: [opening.id], cleared: true });
    const cancelled = await w.s.reconcile.cancel(w.ctx, a.reconciliation.id);
    expect(cancelled.status).toBe('cancelled');
    const still = await w.s.transactions.get(w.ctx, opening.id);
    expect(still.transaction.clearedAccountIds).toContain(w.bank.id);
    expect(still.transaction.reconciled).toBe(false);
  });
});
