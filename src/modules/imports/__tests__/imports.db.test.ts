import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newWorkspace, startTestApp, type TestApp } from '../../../../test/helpers/test-app.js';

let t: TestApp;
beforeAll(async () => {
  t = await startTestApp();
});
afterAll(() => t.close());

const mapping = {
  date: 0,
  amount: 1,
  moneyIn: null,
  moneyOut: null,
  description: 2,
  payee: null,
  notes: null,
  dateFormat: 'YYYY-MM-DD' as const,
  hasHeader: true,
};

async function world() {
  const w = await newWorkspace(t);
  const s = t.services;
  const bank = await s.accounts.create(
    w.ctx,
    { type: 'bank', name: 'GTBank', openingBalance: '10000000', openingDate: '2026-10-01' } as never,
    uuidv7(),
  );
  const tree = await s.categories.tree(w.ctx);
  const food =
    tree.categories.find((c) => c.name === 'Food') ??
    (await s.categories.create(w.ctx, {
      groupId: tree.groups.find((g) => g.name === 'Other')!.id,
      name: 'Food',
    } as never));
  return { ...w, s, bank, food };
}

describe('imports (B1.12)', () => {
  it('upload + map finds a duplicate', async () => {
    const w = await world();
    await w.s.transactions.create(
      w.ctx,
      {
        type: 'expense',
        accountId: w.bank.id,
        categoryId: w.food.id,
        amount: '1500000',
        date: '2026-10-05',
        notes: 'Shoprite groceries',
      } as never,
      uuidv7(),
    );
    const csv = ['Date,Amount,Description', '2026-10-06,-15000.00,Shoprite Groceries', '2026-10-10,-2000.00,Fuel'].join(
      '\n',
    );
    const uploaded = await w.s.imports.upload(w.ctx, {
      accountId: w.bank.id,
      fileName: 'gtb.csv',
      content: csv,
    });
    expect(uploaded.status).toBe('uploaded');
    expect(uploaded.preview.length).toBeGreaterThanOrEqual(2);
    expect(uploaded.stored).toBe(false);
    const mapped = await w.s.imports.map(w.ctx, uploaded.id, mapping);
    expect(mapped.status).toBe('mapped');
    expect(mapped.counts.duplicates).toBe(1);
    expect(mapped.counts.new).toBe(1);
    const dup = mapped.rows.find((r) => r.duplicateOf);
    expect(dup).toMatchObject({ include: false, description: 'Shoprite Groceries' });
    expect(dup!.duplicateOf).toBeTruthy();
    const neu = mapped.rows.find((r) => r.description === 'Fuel');
    expect(neu).toMatchObject({ include: true, duplicateOf: null, error: null });
  });

  it('post posts new rows; balance check ok', async () => {
    const w = await world();
    const csv = ['Date,Amount,Description', '2026-10-08,-5000.00,Uber', '2026-10-09,25000.00,Salary top-up'].join('\n');
    const uploaded = await w.s.imports.upload(w.ctx, {
      accountId: w.bank.id,
      fileName: 'moves.csv',
      content: csv,
    });
    const mapped = await w.s.imports.map(w.ctx, uploaded.id, mapping);
    const posted = await w.s.imports.post(
      w.ctx,
      mapped.id,
      {
        rows: mapped.rows.map((r) => ({
          index: r.index,
          include: r.include,
          categoryId: r.amount && BigInt(r.amount) < 0n ? w.food.id : null,
        })),
      },
      uuidv7(),
    );
    expect(posted.status).toBe('posted');
    expect(posted.counts.posted).toBe(2);
    expect(posted.rows.every((r) => r.transactionId)).toBe(true);
    const list = await w.s.transactions.list(w.ctx, { accountId: [w.bank.id], limit: 20 } as never);
    expect(list.items.some((i) => i.importId === posted.id && i.amount === '-500000')).toBe(true);
    expect(list.items.some((i) => i.importId === posted.id && i.amount === '2500000')).toBe(true);
    expect((await w.s.balanceCheck.check(w.ctx)).ok).toBe(true);
  });

  it('undo reverses posted only', async () => {
    const w = await world();
    const prior = await w.s.transactions.create(
      w.ctx,
      {
        type: 'expense',
        accountId: w.bank.id,
        categoryId: w.food.id,
        amount: '100000',
        date: '2026-10-03',
        notes: 'Keep me',
      } as never,
      uuidv7(),
    );
    const csv = ['Date,Amount,Description', '2026-10-12,-3000.00,Imported only'].join('\n');
    const uploaded = await w.s.imports.upload(w.ctx, {
      accountId: w.bank.id,
      fileName: 'one.csv',
      content: csv,
    });
    const mapped = await w.s.imports.map(w.ctx, uploaded.id, mapping);
    const posted = await w.s.imports.post(
      w.ctx,
      mapped.id,
      { rows: mapped.rows.map((r) => ({ index: r.index, include: true, categoryId: w.food.id })) },
      uuidv7(),
    );
    const txId = posted.rows[0]!.transactionId!;
    const undone = await w.s.imports.undo(w.ctx, posted.id, uuidv7());
    expect(undone.status).toBe('undone');
    expect(undone.rows[0]!.transactionId).toBeNull();
    const reversed = await w.s.transactions.get(w.ctx, txId);
    expect(reversed.transaction.status).toBe('reversed');
    const kept = await w.s.transactions.get(w.ctx, prior.id);
    expect(kept.transaction.status).toBe('posted');
    expect((await w.s.balanceCheck.check(w.ctx)).ok).toBe(true);
  });

  it('broken row reported not posted; errors excluded from post set', async () => {
    const w = await world();
    const csv = [
      'Date,Amount,Description',
      'not-a-date,-1000.00,Bad date',
      '2026-10-15,-2000.00,Good row',
      '2026-10-16,not-money,Bad amount',
    ].join('\n');
    const uploaded = await w.s.imports.upload(w.ctx, {
      accountId: w.bank.id,
      fileName: 'mixed.csv',
      content: csv,
    });
    const mapped = await w.s.imports.map(w.ctx, uploaded.id, mapping);
    expect(mapped.counts.errors).toBe(2);
    expect(mapped.counts.new).toBe(1);
    const broken = mapped.rows.filter((r) => r.error);
    expect(broken.every((r) => r.include === false)).toBe(true);
    const posted = await w.s.imports.post(
      w.ctx,
      mapped.id,
      {
        rows: mapped.rows.map((r) => ({
          index: r.index,
          include: r.error ? true : r.include,
          categoryId: w.food.id,
        })),
      },
      uuidv7(),
    );
    expect(posted.counts.posted).toBe(1);
    expect(posted.rows.filter((r) => r.error).every((r) => r.transactionId === null)).toBe(true);
    expect(posted.rows.find((r) => r.description === 'Good row')!.transactionId).toBeTruthy();
    expect((await w.s.balanceCheck.check(w.ctx)).ok).toBe(true);
  });

  it('remembers column mapping on the account (P09-05)', async () => {
    const w = await world();
    const csv = ['Date,Amount,Description', '2026-10-20,-100.00,Snack'].join('\n');
    const uploaded = await w.s.imports.upload(w.ctx, {
      accountId: w.bank.id,
      fileName: 'map.csv',
      content: csv,
    });
    await w.s.imports.map(w.ctx, uploaded.id, mapping);
    const again = await w.s.imports.upload(w.ctx, {
      accountId: w.bank.id,
      fileName: 'map2.csv',
      content: csv,
    });
    expect(again.mapping).toMatchObject(mapping);
  });
});
