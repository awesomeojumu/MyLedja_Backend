import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newWorkspace, startTestApp, type TestApp } from '../../../../test/helpers/test-app.js';

let t: TestApp;
beforeAll(async () => {
  t = await startTestApp();
});
afterAll(() => t.close());

const create = (ctx: Parameters<TestApp['services']['accounts']['list']>[0], body: Record<string, unknown>) =>
  t.services.accounts.create(ctx, { openingBalance: '0', openingDate: '2026-10-01', ...body } as never, uuidv7());

async function incomeAndExpense(ctx: Parameters<TestApp['services']['accounts']['list']>[0]) {
  const income = await t.services.ledger.transactions.aggregate<{ n: number }>(ctx, [
    { $unwind: '$lines' },
    { $match: { 'lines.categoryId': { $type: 'string' } } },
    { $count: 'n' },
  ]);
  return income[0]?.n ?? 0;
}

describe('accounts', () => {
  it('opening balances are shown as entered and are never income (case 19)', async () => {
    const { ctx } = await newWorkspace(t);
    const bank = await create(ctx, {
      type: 'bank',
      name: 'GTBank Current',
      openingBalance: '81230000',
      institution: 'gtbank',
    });
    const card = await create(ctx, { type: 'card', name: 'Zenith card', openingBalance: '4500000' });
    expect(bank).toMatchObject({
      kind: 'asset',
      group: 'cash_bank',
      balance: '81230000',
      onBudget: true,
      institution: 'gtbank',
    });
    expect(card).toMatchObject({ kind: 'liability', group: 'cards_credit', balance: '4500000' });
    const list = await t.services.accounts.list(ctx);
    expect(list.netWorth).toEqual({ amount: '76730000', assets: '81230000', owed: '4500000', partial: [] });
    expect(await incomeAndExpense(ctx)).toBe(0);
    expect((await t.services.balanceCheck.check(ctx)).ok).toBe(true);
  });

  it('investments, loans and property are tracking accounts by default', async () => {
    const { ctx } = await newWorkspace(t);
    expect((await create(ctx, { type: 'investment', name: 'Stocks' })).onBudget).toBe(false);
    expect((await create(ctx, { type: 'loan', name: 'Car loan' })).onBudget).toBe(false);
  });

  it('refuses a duplicate name, and a device id is kept', async () => {
    const { ctx } = await newWorkspace(t);
    const id = uuidv7();
    expect((await create(ctx, { id, type: 'cash', name: 'Wallet' })).id).toBe(id);
    expect((await create(ctx, { id, type: 'cash', name: 'Wallet' })).id).toBe(id);
    await expect(create(ctx, { type: 'cash', name: ' wallet' })).rejects.toMatchObject({ code: 'name_taken' });
  });

  it('a new value is a revaluation, never income (E10)', async () => {
    const { ctx } = await newWorkspace(t);
    const stocks = await create(ctx, { type: 'investment', name: 'Stocks', openingBalance: '1000000' });
    const after = await t.services.accounts.updateValue(
      ctx,
      stocks.id,
      { value: '1250000', date: '2026-10-20' } as never,
      uuidv7(),
    );
    expect(after.balance).toBe('1250000');
    expect(await incomeAndExpense(ctx)).toBe(0);
    const same = await t.services.accounts.updateValue(
      ctx,
      stocks.id,
      { value: '1250000', date: '2026-10-21' } as never,
      uuidv7(),
    );
    expect(same.version).toBe(after.version);
  });

  it('archive moves the balance first as a transfer, and restore brings it back', async () => {
    const { ctx } = await newWorkspace(t);
    const a = await create(ctx, { type: 'bank', name: 'Old bank', openingBalance: '500000' });
    const b = await create(ctx, { type: 'bank', name: 'New bank' });
    const card = await create(ctx, { type: 'card', name: 'Card', openingBalance: '200000' });
    const archived = await t.services.accounts.archive(
      ctx,
      a.id,
      { baseVersion: a.version, moveBalanceTo: b.id, date: '2026-10-10' } as never,
      uuidv7(),
    );
    expect(archived).toMatchObject({ archived: true, closedWithBalance: false, balance: '0' });
    expect((await t.services.accounts.get(ctx, b.id)).balance).toBe('500000');

    const paid = await t.services.accounts.archive(
      ctx,
      card.id,
      { baseVersion: card.version, moveBalanceTo: b.id, date: '2026-10-10' } as never,
      uuidv7(),
    );
    expect(paid.balance).toBe('0');
    expect((await t.services.accounts.get(ctx, b.id)).balance).toBe('300000');

    const restored = await t.services.accounts.restore(ctx, a.id);
    expect(restored.archived).toBe(false);
    await expect(
      t.services.accounts.archive(
        ctx,
        b.id,
        { baseVersion: 0, moveBalanceTo: null, date: '2026-10-10' } as never,
        uuidv7(),
      ),
    ).rejects.toMatchObject({ code: 'already_changed' });
    const kept = await t.services.accounts.archive(
      ctx,
      b.id,
      {
        baseVersion: (await t.services.accounts.get(ctx, b.id)).version,
        moveBalanceTo: null,
        date: '2026-10-10',
      } as never,
      uuidv7(),
    );
    expect(kept).toMatchObject({ archived: true, closedWithBalance: true, balance: '300000' });
    expect((await t.services.accounts.list(ctx)).netWorth.amount).toBe('300000');
  });

  it('reorder saves the order given, with the rest after', async () => {
    const { ctx } = await newWorkspace(t);
    const x = await create(ctx, { type: 'cash', name: 'X' });
    const y = await create(ctx, { type: 'cash', name: 'Y' });
    const z = await create(ctx, { type: 'cash', name: 'Z' });
    const list = await t.services.accounts.reorder(ctx, [z.id, x.id]);
    expect(list.accounts.map((a) => a.name)).toEqual(['Z', 'X', 'Y']);
    await expect(t.services.accounts.reorder(ctx, [uuidv7()])).rejects.toMatchObject({ code: 'invalid_input' });
    void y;
  });
});
