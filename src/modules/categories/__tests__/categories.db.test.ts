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
  const bank = await s.ledger.openAccount(w.ctx, {
    kind: 'asset',
    accountType: 'bank',
    name: 'GTBank',
    currency: 'NGN',
  });
  const tree = await s.categories.tree(w.ctx);
  const other = tree.groups.find((g) => g.name === 'Other')!;
  const food = await s.categories.create(w.ctx, { groupId: other.id, name: 'Food' } as never);
  const eatOut = await s.categories.create(w.ctx, { groupId: other.id, name: 'Eating out' } as never);
  const spend = (categoryId: string, amount = '500000', extra: Record<string, unknown> = {}) =>
    s.ledger.post(
      w.ctx,
      {
        type: 'expense',
        accountId: bank._id,
        categoryId,
        amount,
        date: '2026-10-05',
        payeeId: null,
        notes: null,
        tagIds: [],
        ...extra,
      } as never,
      { operationId: uuidv7() },
    );
  return { ...w, s, bank, other, food, eatOut, spend };
}

describe('default categories', () => {
  it('a new workspace has Income and Other groups with the built-in categories', async () => {
    const { ctx } = await newWorkspace(t);
    const tree = await t.services.categories.tree(ctx);
    expect(tree.groups.map((g) => g.name)).toEqual(['Income', 'Other']);
    const keys = tree.categories.map((c) => c.starterKey).sort();
    expect(keys).toEqual(
      [
        'fees',
        'interest_and_charges',
        'interest_earned',
        'investment_gain',
        'investment_income',
        'other_income',
        'taxes',
        'uncategorized',
      ].sort(),
    );
    const fees = tree.categories.find((c) => c.starterKey === 'fees')!;
    expect(fees.system).toBe('fees');
    const account = await t.services.ledger.accounts.findOne(ctx, { categoryId: fees.id });
    expect(account?.systemKey).toBe('fees');
  });

  it('seeding twice adds nothing', async () => {
    const { ctx } = await newWorkspace(t);
    await t.database.transaction((session) => t.services.categories.seedDefaults(ctx, 'NGN', session));
    const tree = await t.services.categories.tree(ctx);
    expect(tree.groups).toHaveLength(2);
    expect(tree.categories).toHaveLength(8);
  });
});

describe('categories', () => {
  it('refuses a duplicate name in the same kind', async () => {
    const w = await world();
    await expect(w.s.categories.create(w.ctx, { groupId: w.other.id, name: ' food ' } as never)).rejects.toMatchObject({
      code: 'name_taken',
    });
  });

  it('rename also renames its ledger account, and a stale version is refused', async () => {
    const w = await world();
    const after = await w.s.categories.update(w.ctx, w.food.id, { baseVersion: 1, name: 'Groceries' } as never);
    expect(after).toMatchObject({ name: 'Groceries', version: 2 });
    expect((await w.s.ledger.accounts.findOne(w.ctx, { categoryId: w.food.id }))?.name).toBe('Groceries');
    await expect(w.s.categories.update(w.ctx, w.food.id, { baseVersion: 1, name: 'X' } as never)).rejects.toMatchObject(
      { code: 'already_changed' },
    );
  });

  it('delete moves every transaction (as a correction) and undo brings them back', async () => {
    const w = await world();
    await w.spend(w.food.id, '500000');
    await w.spend(w.food.id, '250000');
    await expect(w.s.categories.remove(w.ctx, w.food.id, null, uuidv7())).rejects.toMatchObject({
      code: 'move_to_needed',
    });

    const res = await w.s.categories.remove(w.ctx, w.food.id, w.eatOut.id, uuidv7());
    expect(res.moved).toBe(2);
    expect((await w.s.categories.tree(w.ctx)).categories.some((c) => c.id === w.food.id)).toBe(false);
    expect(await w.s.categories.liveEventsIn(w.ctx, w.food.id)).toHaveLength(0);
    expect(await w.s.categories.liveEventsIn(w.ctx, w.eatOut.id)).toHaveLength(2);
    expect((await w.s.balanceCheck.check(w.ctx)).ok).toBe(true);

    const back = await w.s.categories.undoRemove(w.ctx, res.undoId, uuidv7());
    expect(back.id).toBe(w.food.id);
    expect(await w.s.categories.liveEventsIn(w.ctx, w.food.id)).toHaveLength(2);
    expect(await w.s.categories.liveEventsIn(w.ctx, w.eatOut.id)).toHaveLength(0);
    await expect(w.s.categories.undoRemove(w.ctx, res.undoId, uuidv7())).rejects.toMatchObject({
      code: 'already_undone',
    });
  });

  it('honors a client-minted undoId so device toast Undo matches the server', async () => {
    const w = await world();
    await w.spend(w.food.id, '100000');
    const clientUndoId = uuidv7();
    const res = await w.s.categories.remove(w.ctx, w.food.id, w.eatOut.id, uuidv7(), clientUndoId);
    expect(res.undoId).toBe(clientUndoId);
    const back = await w.s.categories.undoRemove(w.ctx, clientUndoId, uuidv7());
    expect(back.id).toBe(w.food.id);
    expect(await w.s.categories.liveEventsIn(w.ctx, w.food.id)).toHaveLength(1);
  });

  it('delete moves budget amounts and setCategory rules; undo restores them', async () => {
    const w = await world();
    await w.s.budget.assign(w.ctx, '2026-10', w.food.id, { assigned: '1200000' } as never);
    await w.s.rules.upsert(
      w.ctx,
      uuidv7(),
      {
        enabled: true,
        stage: 'normal',
        order: 0,
        matchMode: 'all',
        conditions: [{ field: 'payee', op: 'contains', value: 'Shoprite' }],
        actions: [{ kind: 'setCategory', value: w.food.id }],
      } as never,
      null,
    );
    const beforeRules = await w.s.rules.list(w.ctx);
    const rule = beforeRules.rules.find((r) => r.actions.some((a) => a.kind === 'setCategory' && a.value === w.food.id))!;

    const res = await w.s.categories.remove(w.ctx, w.food.id, w.eatOut.id, uuidv7());
    const month = await w.s.budget.get(w.ctx, '2026-10');
    const eatOutRow = month.months[0]!.categories.find((c) => c.categoryId === w.eatOut.id);
    expect(BigInt(eatOutRow?.assigned ?? '0')).toBeGreaterThanOrEqual(1_200_000n);
    const afterRules = await w.s.rules.list(w.ctx);
    expect(afterRules.rules.find((r) => r.id === rule.id)?.actions.some((a) => a.value === w.eatOut.id)).toBe(true);

    await w.s.categories.undoRemove(w.ctx, res.undoId, uuidv7());
    const restored = await w.s.budget.get(w.ctx, '2026-10');
    const foodRow = restored.months[0]!.categories.find((c) => c.categoryId === w.food.id);
    expect(foodRow?.assigned).toBe('1200000');
    const rulesBack = await w.s.rules.list(w.ctx);
    expect(rulesBack.rules.find((r) => r.id === rule.id)?.actions.some((a) => a.value === w.food.id)).toBe(true);
  });

  it('built-in categories cannot be deleted, and moving across kinds is refused', async () => {
    const w = await world();
    const tree = await w.s.categories.tree(w.ctx);
    const fees = tree.categories.find((c) => c.starterKey === 'fees')!;
    const income = tree.categories.find((c) => c.starterKey === 'other_income')!;
    await expect(w.s.categories.remove(w.ctx, fees.id, null, uuidv7())).rejects.toMatchObject({
      code: 'system_category',
    });
    await w.spend(w.food.id);
    await expect(w.s.categories.remove(w.ctx, w.food.id, income.id, uuidv7())).rejects.toMatchObject({
      code: 'wrong_category',
    });
  });

  it('a group with categories cannot be deleted; an empty one can', async () => {
    const w = await world();
    await expect(w.s.categories.removeGroup(w.ctx, w.other.id)).rejects.toMatchObject({ code: 'group_not_empty' });
    const g = await w.s.categories.createGroup(w.ctx, { name: 'Faith', kind: 'expense' } as never);
    await w.s.categories.removeGroup(w.ctx, g.id);
    expect((await w.s.categories.tree(w.ctx)).groups.some((x) => x.id === g.id)).toBe(false);
  });

  it('Welcome setup categories are made once, in the named group', async () => {
    const { ctx } = await newWorkspace(t);
    const list = [
      { key: 'rent', group: 'Home', name: 'Rent' },
      { key: 'salary', group: 'Income', name: 'Salary' },
    ];
    await t.database.transaction((session) => t.services.categories.ensureFromSetup(ctx, list, 'NGN', session));
    await t.database.transaction((session) => t.services.categories.ensureFromSetup(ctx, list, 'NGN', session));
    const tree = await t.services.categories.tree(ctx);
    const rent = tree.categories.filter((c) => c.name === 'Rent');
    expect(rent).toHaveLength(1);
    expect(tree.groups.find((g) => g.id === rent[0]!.groupId)?.name).toBe('Home');
    expect(tree.categories.find((c) => c.name === 'Salary')?.kind).toBe('income');
  });
});

describe('tags', () => {
  it('deleting a tag takes it off every transaction', async () => {
    const w = await world();
    const tag = await w.s.categories.createTag(w.ctx, { name: 'Trip' });
    await expect(w.s.categories.createTag(w.ctx, { name: 'trip' })).rejects.toMatchObject({ code: 'name_taken' });
    const { event } = await w.spend(w.food.id, '1000', { tagIds: [tag.id] });
    await w.s.categories.removeTag(w.ctx, tag.id);
    expect((await w.s.ledger.transactions.byId(w.ctx, event._id))?.tagIds).toEqual([]);
    expect((await w.s.categories.listTags(w.ctx)).tags).toEqual([]);
  });
});

describe('payees', () => {
  it('merge moves transactions and keeps names as aliases; undo restores both', async () => {
    const w = await world();
    const a = await w.s.categories.createPayee(w.ctx, { name: 'Shoprite' } as never);
    const b = await w.s.categories.createPayee(w.ctx, {
      name: 'SHOPRITE LEKKI',
      aliases: ['Shoprite Lekki Mall'],
    } as never);
    await w.spend(w.food.id, '1000', { payeeId: a.id });
    const { event } = await w.spend(w.food.id, '2000', { payeeId: b.id });

    const merged = await w.s.categories.mergePayees(w.ctx, {
      keepId: a.id,
      mergeIds: [b.id],
      logoFromId: b.id,
      categoryFromId: b.id,
    } as never);
    expect(merged.moved).toBe(1);
    expect(merged.payee).toMatchObject({ transactionCount: 2, spentThisYear: '3000' });
    expect(merged.payee.aliases).toEqual(['SHOPRITE LEKKI', 'Shoprite Lekki Mall']);
    expect((await w.s.ledger.transactions.byId(w.ctx, event._id))?.payeeId).toBe(a.id);
    const page = await w.s.categories.listPayees(w.ctx, { q: 'lekki', limit: 50 });
    expect(page.items.map((p) => p.id)).toEqual([a.id]);

    const undone = await w.s.categories.undoMerge(w.ctx, merged.mergeId);
    expect(undone.payees).toHaveLength(2);
    expect((await w.s.ledger.transactions.byId(w.ctx, event._id))?.payeeId).toBe(b.id);
    expect((await w.s.categories.getPayee(w.ctx, a.id)).aliases).toEqual([]);
  });

  it('PU46-2: rejects a bank name already owned by another payee', async () => {
    const w = await world();
    const a = await w.s.categories.createPayee(w.ctx, {
      name: 'Shoprite',
      aliases: ['POS SHOPRITE'],
    } as never);
    const b = await w.s.categories.createPayee(w.ctx, { name: 'Corner shop' } as never);
    await expect(
      w.s.categories.updatePayee(w.ctx, b.id, { baseVersion: b.version, aliases: ['POS SHOPRITE'] } as never),
    ).rejects.toMatchObject({ code: 'alias_taken', extra: expect.objectContaining({ ownerName: 'Shoprite' }) });
    await expect(
      w.s.categories.createPayee(w.ctx, { name: 'Other', aliases: ['Shoprite'] } as never),
    ).rejects.toMatchObject({ code: 'alias_taken' });
    expect(a.id).toBeTruthy();
  });

  it('deletes a payee with no transactions; refuses when it has some', async () => {
    const w = await world();
    const empty = await w.s.categories.createPayee(w.ctx, { name: 'Unused' } as never);
    await expect(w.s.categories.deletePayee(w.ctx, empty.id)).resolves.toEqual({ payeeId: empty.id });
    await expect(w.s.categories.getPayee(w.ctx, empty.id)).rejects.toMatchObject({ code: 'not_found' });
    const used = await w.s.categories.createPayee(w.ctx, { name: 'Used' } as never);
    await w.spend(w.food.id, '500', { payeeId: used.id });
    await expect(w.s.categories.deletePayee(w.ctx, used.id)).rejects.toMatchObject({
      code: 'payee_has_transactions',
    });
  });

  it('returns a logoUrl when logoFileId is a direct URL', async () => {
    const w = await world();
    const p = await w.s.categories.createPayee(w.ctx, {
      name: 'With logo',
      logoFileId: 'https://cdn.example/logo.png',
    } as never);
    expect(p.logoUrl).toBe('https://cdn.example/logo.png');
  });

  it('lists in name order across pages', async () => {
    const { ctx } = await newWorkspace(t);
    for (const n of ['Cafe', 'Bolt', 'Apple', 'Dangote'])
      await t.services.categories.createPayee(ctx, { name: n } as never);
    const one = await t.services.categories.listPayees(ctx, { limit: 3 });
    expect(one.items.map((p) => p.name)).toEqual(['Apple', 'Bolt', 'Cafe']);
    const two = await t.services.categories.listPayees(ctx, { limit: 3, cursor: one.nextCursor! });
    expect(two.items.map((p) => p.name)).toEqual(['Dangote']);
    expect(two.nextCursor).toBeNull();
  });
});
