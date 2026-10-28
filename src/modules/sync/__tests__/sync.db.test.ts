import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newWorkspace, startTestApp, type TestApp } from '../../../../test/helpers/test-app.js';
import { CURRENT_SCHEMA_VERSION } from '../sync.contract.js';

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
  const food =
    tree.categories.find((c) => c.name === 'Food') ??
    (await s.categories.create(w.ctx, {
      groupId: tree.groups.find((g) => g.name === 'Other')!.id,
      name: 'Food',
    } as never));
  return { ...w, s, bank, food };
}

function op(
  type: string,
  payload: Record<string, unknown>,
  extra: { targetId?: string | null; baseVersion?: number | null; operationId?: string } = {},
) {
  return {
    operationId: extra.operationId ?? uuidv7(),
    type,
    targetId: extra.targetId ?? null,
    payload,
    baseVersion: extra.baseVersion ?? null,
    createdAt: new Date().toISOString(),
    schemaVersion: CURRENT_SCHEMA_VERSION,
  };
}

describe('sync (B1.11)', () => {
  it('duplicate operation → duplicate status', async () => {
    const w = await world();
    const operationId = uuidv7();
    const create = op(
      'transaction.create',
      {
        type: 'expense',
        accountId: w.bank.id,
        categoryId: w.food.id,
        amount: '150000',
        date: '2026-10-05',
      },
      { operationId },
    );
    const first = await w.s.sync.push(w.ctx, { deviceId: 'phone-a', operations: [create as never] });
    expect(first.results).toHaveLength(1);
    expect(first.results[0]).toMatchObject({ operationId, status: 'applied' });
    expect(first.results[0]!.result).toMatchObject({ amount: '-150000' });

    const second = await w.s.sync.push(w.ctx, { deviceId: 'phone-a', operations: [create as never] });
    expect(second.results[0]).toMatchObject({ operationId, status: 'duplicate' });
    expect(second.results[0]!.result).toMatchObject({
      id: (first.results[0]!.result as { id: string }).id,
      amount: '-150000',
    });
  });

  it('two devices correct same txn → second conflict', async () => {
    const w = await world();
    const created = await w.s.transactions.create(
      w.ctx,
      {
        type: 'expense',
        accountId: w.bank.id,
        categoryId: w.food.id,
        amount: '200000',
        date: '2026-10-06',
      } as never,
      uuidv7(),
    );

    const a = await w.s.sync.push(w.ctx, {
      deviceId: 'phone-a',
      operations: [
        op(
          'transaction.correct',
          {
            baseVersion: created.version,
            input: {
              type: 'expense',
              accountId: w.bank.id,
              categoryId: w.food.id,
              amount: '180000',
              date: '2026-10-06',
            },
          },
          { targetId: created.id },
        ) as never,
      ],
    });
    expect(a.results[0]!.status).toBe('applied');

    const b = await w.s.sync.push(w.ctx, {
      deviceId: 'phone-b',
      operations: [
        op(
          'transaction.correct',
          {
            baseVersion: created.version,
            input: {
              type: 'expense',
              accountId: w.bank.id,
              categoryId: w.food.id,
              amount: '190000',
              date: '2026-10-06',
            },
          },
          { targetId: created.id },
        ) as never,
      ],
    });
    expect(b.results[0]).toMatchObject({
      status: 'conflict',
      error: { code: 'already_changed' },
    });
    expect(b.results[0]!.current).toBeTruthy();
  });

  it('push then pull returns changes', async () => {
    const w = await world();
    const before = await w.s.sync.pull(w.ctx, { since: '0', limit: 500 });
    const pushed = await w.s.sync.push(w.ctx, {
      deviceId: 'phone-a',
      operations: [
        op('transaction.create', {
          type: 'expense',
          accountId: w.bank.id,
          categoryId: w.food.id,
          amount: '75000',
          date: '2026-10-07',
        }) as never,
      ],
    });
    expect(pushed.results[0]!.status).toBe('applied');
    const txnId = (pushed.results[0]!.result as { id: string }).id;

    const after = await w.s.sync.pull(w.ctx, { since: before.nextSince, limit: 500 });
    expect(after.reset).toBe(false);
    expect(after.changes.some((c) => c.collection === 'transactions' && c.id === txnId && c.op === 'upsert')).toBe(
      true,
    );
    const change = after.changes.find((c) => c.id === txnId)!;
    expect(change.doc).toMatchObject({ id: txnId, amount: '-75000' });
    expect(BigInt(after.nextSince)).toBeGreaterThanOrEqual(BigInt(pushed.seq));
  });

  it('long-offline: since=0 works; since behind min seq → reset', async () => {
    const w = await world();
    await w.s.sync.push(w.ctx, {
      deviceId: 'phone-a',
      operations: [
        op('transaction.create', {
          type: 'expense',
          accountId: w.bank.id,
          categoryId: w.food.id,
          amount: '10000',
          date: '2026-10-08',
        }) as never,
        op('transaction.create', {
          type: 'expense',
          accountId: w.bank.id,
          categoryId: w.food.id,
          amount: '20000',
          date: '2026-10-09',
        }) as never,
      ],
    });

    const fromZero = await w.s.sync.pull(w.ctx, { since: '0', limit: 500 });
    expect(fromZero.reset).toBe(false);
    expect(fromZero.changes.length).toBeGreaterThan(0);

    const rows = await t.db.collection('changes').find({ workspaceId: w.workspaceId }).sort({ seq: 1 }).toArray();
    expect(rows.length).toBeGreaterThan(1);
    const keepFrom = rows[Math.floor(rows.length / 2)]!;
    await t.db.collection('changes').deleteMany({
      workspaceId: w.workspaceId,
      seq: { $lt: keepFrom.seq },
    });

    const behind = await w.s.sync.pull(w.ctx, { since: '1', limit: 500 });
    expect(behind).toMatchObject({ reset: true, changes: [], nextSince: '0', hasMore: false });

    const stillFresh = await w.s.sync.pull(w.ctx, { since: '0', limit: 500 });
    expect(stillFresh.reset).toBe(false);
    expect(stillFresh.changes.length).toBeGreaterThan(0);
  });

  it('rejected op does not stop the rest of the batch', async () => {
    const w = await world();
    const badId = uuidv7();
    const good = op('transaction.create', {
      type: 'expense',
      accountId: w.bank.id,
      categoryId: w.food.id,
      amount: '30000',
      date: '2026-10-10',
    });
    const bad = op('transaction.update', { baseVersion: 1, notes: 'nope' }, { targetId: badId });
    const out = await w.s.sync.push(w.ctx, {
      deviceId: 'phone-a',
      operations: [bad as never, good as never],
    });
    expect(out.results[0]!.status).toBe('rejected');
    expect(out.results[1]!.status).toBe('applied');
  });
});
