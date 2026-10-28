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
  const cash = await s.accounts.create(
    w.ctx,
    { type: 'cash', name: 'Wallet', openingBalance: '0', openingDate: '2026-10-01' } as never,
    uuidv7(),
  );
  const tree = await s.categories.tree(w.ctx);
  const other = tree.groups.find((g) => g.name === 'Other')!;
  const income = tree.groups.find((g) => g.name === 'Income')!;
  const food = await s.categories.create(w.ctx, { groupId: other.id, name: 'Food' } as never);
  const salary = tree.categories.find((c) => c.starterKey === 'other_income')!;
  const unc = tree.categories.find((c) => c.starterKey === 'uncategorized')!;
  return { ...w, s, bank, cash, other, income, food, salary, unc };
}

describe('transactions (B1.8)', () => {
  it('creates income and expense, lists live newest first, and pages stably', async () => {
    const w = await world();
    const a = await w.s.transactions.create(
      w.ctx,
      {
        type: 'expense',
        accountId: w.bank.id,
        categoryId: w.food.id,
        amount: '1845000',
        date: '2026-10-12',
      } as never,
      uuidv7(),
    );
    expect(a).toMatchObject({ type: 'expense', amount: '-1845000', accountIds: [w.bank.id], edited: false });
    const b = await w.s.transactions.create(
      w.ctx,
      {
        type: 'income',
        accountId: w.bank.id,
        categoryId: w.salary.id,
        amount: '50000000',
        date: '2026-10-15',
      } as never,
      uuidv7(),
    );
    expect(b.amount).toBe('50000000');
    const page1 = await w.s.transactions.list(w.ctx, { status: 'live', limit: 1 } as never);
    expect(page1.items.map((x) => x.id)).toEqual([b.id]);
    expect(page1.nextCursor).toBeTruthy();
    const page2 = await w.s.transactions.list(w.ctx, {
      status: 'live',
      limit: 10,
      cursor: page1.nextCursor!,
    } as never);
    expect(page2.items.map((x) => x.id)).toContain(a.id);
    // Opening balance is also live.
    expect(page2.items.some((x) => x.type === 'opening_balance')).toBe(true);
  });

  it('corrects as reversal + new event, and refuses a second correct of the original (case 21)', async () => {
    const w = await world();
    const first = await w.s.transactions.create(
      w.ctx,
      {
        type: 'expense',
        accountId: w.bank.id,
        categoryId: w.food.id,
        amount: '100000',
        date: '2026-10-10',
      } as never,
      uuidv7(),
    );
    const { transaction, reversal } = await w.s.transactions.correct(
      w.ctx,
      first.id,
      {
        baseVersion: first.version,
        input: {
          type: 'expense',
          accountId: w.bank.id,
          categoryId: w.food.id,
          amount: '120000',
          date: '2026-10-10',
        },
      } as never,
      uuidv7(),
    );
    expect(transaction).toMatchObject({ amount: '-120000', edited: true });
    expect(reversal.type).toBe('reversal');
    const detail = await w.s.transactions.get(w.ctx, transaction.id);
    expect(detail.history.some((h) => h.id === first.id)).toBe(true);
    await expect(
      w.s.transactions.correct(
        w.ctx,
        first.id,
        {
          baseVersion: first.version,
          input: {
            type: 'expense',
            accountId: w.bank.id,
            categoryId: w.food.id,
            amount: '90000',
            date: '2026-10-10',
          },
        } as never,
        uuidv7(),
      ),
    ).rejects.toMatchObject({ code: 'already_changed' });
  });

  it('refunds credit the original category and caps the remaining (cases 13-14)', async () => {
    const w = await world();
    const buy = await w.s.transactions.create(
      w.ctx,
      {
        type: 'expense',
        accountId: w.bank.id,
        categoryId: w.food.id,
        amount: '500000',
        date: '2026-10-05',
      } as never,
      uuidv7(),
    );
    const refund = await w.s.transactions.create(
      w.ctx,
      {
        type: 'refund',
        refundOf: buy.id,
        accountId: w.bank.id,
        categoryId: w.food.id,
        amount: '200000',
        date: '2026-10-20',
      } as never,
      uuidv7(),
    );
    expect(refund).toMatchObject({ type: 'refund', amount: '200000', categoryIds: [w.food.id] });
    const detail = await w.s.transactions.get(w.ctx, buy.id);
    expect(detail.refundable).toBe('300000');
    expect(detail.refunds.map((r) => r.id)).toEqual([refund.id]);
    await expect(
      w.s.transactions.create(
        w.ctx,
        {
          type: 'refund',
          refundOf: buy.id,
          accountId: w.bank.id,
          categoryId: w.food.id,
          amount: '400000',
          date: '2026-10-21',
        } as never,
        uuidv7(),
      ),
    ).rejects.toMatchObject({ code: 'refund_too_big' });
  });

  it('create with the same operation id returns the first event (case 22)', async () => {
    const w = await world();
    const op = uuidv7();
    const body = {
      type: 'expense',
      accountId: w.bank.id,
      categoryId: w.food.id,
      amount: '1000',
      date: '2026-10-08',
    } as const;
    const a = await w.s.transactions.create(w.ctx, body as never, op);
    const b = await w.s.transactions.create(w.ctx, body as never, op);
    expect(b.id).toBe(a.id);
    const live = await w.s.transactions.list(w.ctx, {
      status: 'live',
      type: ['expense'],
      limit: 50,
    } as never);
    expect(live.items.filter((x) => x.amount === '-1000')).toHaveLength(1);
  });

  it('bulk categorize corrects, and delete reverses', async () => {
    const w = await world();
    const a = await w.s.transactions.create(
      w.ctx,
      {
        type: 'expense',
        accountId: w.bank.id,
        categoryId: w.unc.id,
        amount: '250000',
        date: '2026-10-11',
      } as never,
      uuidv7(),
    );
    const bulk = await w.s.transactions.bulk(
      w.ctx,
      { transactionIds: [a.id], action: { kind: 'categorize', categoryId: w.food.id } } as never,
      uuidv7(),
    );
    expect(bulk.results[0]).toMatchObject({ status: 'changed' });
    expect(bulk.results[0]!.transaction?.categoryIds).toEqual([w.food.id]);
    const del = await w.s.transactions.bulk(
      w.ctx,
      {
        transactionIds: [bulk.results[0]!.transaction!.id],
        action: { kind: 'delete' },
      } as never,
      uuidv7(),
    );
    expect(del.results[0]?.status).toBe('changed');
    const live = await w.s.transactions.list(w.ctx, {
      status: 'live',
      type: ['expense'],
      limit: 50,
    } as never);
    expect(live.items.find((x) => x.id === bulk.results[0]!.transaction!.id)).toBeUndefined();
  });

  it('suggests, links and dismisses a transfer pair', async () => {
    const w = await world();
    const out = await w.s.transactions.create(
      w.ctx,
      {
        type: 'expense',
        accountId: w.bank.id,
        categoryId: w.unc.id,
        amount: '300000',
        date: '2026-10-14',
        notes: 'ATM',
      } as never,
      uuidv7(),
    );
    const inn = await w.s.transactions.create(
      w.ctx,
      {
        type: 'income',
        accountId: w.cash.id,
        categoryId: w.salary.id,
        amount: '300000',
        date: '2026-10-15',
        notes: 'ATM',
      } as never,
      uuidv7(),
    );
    const { suggestions } = await w.s.transactions.transferSuggestions(w.ctx);
    expect(suggestions.some((s) => s.out.id === out.id && s.in.id === inn.id)).toBe(true);
    const linked = await w.s.transactions.linkTransfer(w.ctx, { outId: out.id, inId: inn.id }, uuidv7());
    expect(linked).toMatchObject({ type: 'transfer', amount: '300000', accountIds: [w.bank.id, w.cash.id] });
    const after = await w.s.transactions.transferSuggestions(w.ctx);
    expect(after.suggestions.some((s) => s.out.id === out.id)).toBe(false);

    const out2 = await w.s.transactions.create(
      w.ctx,
      {
        type: 'expense',
        accountId: w.bank.id,
        categoryId: w.unc.id,
        amount: '100000',
        date: '2026-10-16',
      } as never,
      uuidv7(),
    );
    const in2 = await w.s.transactions.create(
      w.ctx,
      {
        type: 'income',
        accountId: w.cash.id,
        categoryId: w.salary.id,
        amount: '100000',
        date: '2026-10-17',
      } as never,
      uuidv7(),
    );
    await w.s.transactions.dismissTransfer(w.ctx, { outId: out2.id, inId: in2.id });
    const dismissed = await w.s.transactions.transferSuggestions(w.ctx);
    expect(dismissed.suggestions.some((s) => s.out.id === out2.id && s.in.id === in2.id)).toBe(false);
  });

  it('unlock clears a reconcile lock so a correction can proceed', async () => {
    const w = await world();
    const tx = await w.s.transactions.create(
      w.ctx,
      {
        type: 'expense',
        accountId: w.bank.id,
        categoryId: w.food.id,
        amount: '50000',
        date: '2026-10-09',
      } as never,
      uuidv7(),
    );
    const reconId = uuidv7();
    await t.db.collection('transactions').updateOne({ _id: tx.id as never }, { $set: { reconciliationId: reconId } });
    await expect(
      w.s.transactions.correct(
        w.ctx,
        tx.id,
        {
          baseVersion: tx.version,
          input: {
            type: 'expense',
            accountId: w.bank.id,
            categoryId: w.food.id,
            amount: '40000',
            date: '2026-10-09',
          },
        } as never,
        uuidv7(),
      ),
    ).rejects.toMatchObject({ code: 'reconciled' });
    const unlocked = await w.s.transactions.unlock(w.ctx, tx.id);
    expect(unlocked.reconciled).toBe(false);
    const { transaction } = await w.s.transactions.correct(
      w.ctx,
      unlocked.id,
      {
        baseVersion: unlocked.version,
        input: {
          type: 'expense',
          accountId: w.bank.id,
          categoryId: w.food.id,
          amount: '40000',
          date: '2026-10-09',
        },
      } as never,
      uuidv7(),
    );
    expect(transaction.amount).toBe('-40000');
  });
});
