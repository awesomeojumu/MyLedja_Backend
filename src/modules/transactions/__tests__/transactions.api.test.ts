import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { moneyWorld, sixPack } from '../../../../test/helpers/six-pack.js';
import { op, signUp, startTestApp, type TestApp } from '../../../../test/helpers/test-app.js';

let t: TestApp;
beforeAll(async () => {
  t = await startTestApp();
});
afterAll(() => t.close());

async function postExpense(
  owner: { auth: Record<string, string> },
  w: Awaited<ReturnType<typeof moneyWorld>>,
  amount = '1845000',
) {
  return (
    await t.app.inject({
      method: 'POST',
      url: `${w.base}/transactions`,
      headers: { ...owner.auth, ...op() },
      payload: {
        type: 'expense',
        accountId: w.account.id,
        categoryId: w.fees.id,
        amount,
        date: '2026-10-12',
      },
    })
  ).json();
}

describe('transactions API (smoke)', () => {
  it('posts, lists, corrects and reverses through HTTP', async () => {
    const ada = await signUp(t);
    const base = `/v1/workspaces/${ada.workspaceId}`;
    const accounts = (
      await t.app.inject({
        method: 'POST',
        url: `${base}/accounts`,
        headers: { ...ada.auth, ...op() },
        payload: { type: 'bank', name: 'GTBank', openingBalance: '5000000', openingDate: '2026-10-01' },
      })
    ).json();
    const cats = (await t.app.inject({ method: 'GET', url: `${base}/categories`, headers: ada.auth })).json();
    const foodGroup = cats.groups.find((g: { name: string }) => g.name === 'Other');
    const food = (
      await t.app.inject({
        method: 'POST',
        url: `${base}/categories`,
        headers: { ...ada.auth, ...op() },
        payload: { groupId: foodGroup.id, name: 'Food' },
      })
    ).json();

    const created = await t.app.inject({
      method: 'POST',
      url: `${base}/transactions`,
      headers: { ...ada.auth, ...op() },
      payload: {
        type: 'expense',
        accountId: accounts.id,
        categoryId: food.id,
        amount: '1845000',
        date: '2026-10-12',
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ type: 'expense', amount: '-1845000' });

    const list = await t.app.inject({
      method: 'GET',
      url: `${base}/transactions?type=expense`,
      headers: ada.auth,
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().items[0].id).toBe(created.json().id);

    const corrected = await t.app.inject({
      method: 'POST',
      url: `${base}/transactions/${created.json().id}/correct`,
      headers: { ...ada.auth, ...op() },
      payload: {
        baseVersion: created.json().version,
        input: {
          type: 'expense',
          accountId: accounts.id,
          categoryId: food.id,
          amount: '2000000',
          date: '2026-10-12',
        },
      },
    });
    expect(corrected.statusCode).toBe(200);
    expect(corrected.json().transaction.amount).toBe('-2000000');

    const reversed = await t.app.inject({
      method: 'POST',
      url: `${base}/transactions/${corrected.json().transaction.id}/reverse`,
      headers: { ...ada.auth, ...op() },
      payload: { baseVersion: corrected.json().transaction.version },
    });
    expect(reversed.statusCode).toBe(200);
    expect(reversed.json().type).toBe('reversal');
  });
});

sixPack('GET /v1/workspaces/:workspaceId/transactions', {
  t: () => t,
  write: false,
  prepare: async (owner) => {
    const w = await moneyWorld(t, owner);
    await postExpense(owner, w);
    return {
      method: 'GET',
      url: `${w.base}/transactions?type=expense`,
      badUrl: `${w.base}/transactions?limit=0`,
      assert: (res) => expect(res.json().items.length).toBeGreaterThanOrEqual(1),
    };
  },
});

sixPack('GET /v1/workspaces/:workspaceId/transactions/:transactionId', {
  t: () => t,
  write: false,
  prepare: async (owner) => {
    const w = await moneyWorld(t, owner);
    const tx = await postExpense(owner, w);
    return {
      method: 'GET',
      url: `${w.base}/transactions/${tx.id}`,
      badUrl: `${w.base}/transactions/not-a-uuid`,
      assert: (res) => expect(res.json().transaction.id).toBe(tx.id),
    };
  },
});

sixPack('POST /v1/workspaces/:workspaceId/transactions', {
  t: () => t,
  write: true,
  prepare: async (owner) => {
    const w = await moneyWorld(t, owner);
    return {
      method: 'POST',
      url: `${w.base}/transactions`,
      status: 201,
      payload: {
        type: 'expense',
        accountId: w.account.id,
        categoryId: w.fees.id,
        amount: '100000',
        date: '2026-10-12',
      },
      badPayload: {
        type: 'expense',
        accountId: w.account.id,
        categoryId: w.fees.id,
        amount: '10.50',
        date: '2026-10-12',
      },
      assert: (res) => expect(res.json()).toMatchObject({ type: 'expense', amount: '-100000' }),
    };
  },
});

sixPack('PATCH /v1/workspaces/:workspaceId/transactions/:transactionId', {
  t: () => t,
  write: true,
  prepare: async (owner) => {
    const w = await moneyWorld(t, owner);
    const tx = await postExpense(owner, w);
    return {
      method: 'PATCH',
      url: `${w.base}/transactions/${tx.id}`,
      payload: { baseVersion: tx.version, notes: 'Updated note' },
      badPayload: { baseVersion: 'nope', notes: 'x' },
      assert: (res) => expect(res.json().notes).toBe('Updated note'),
    };
  },
});

sixPack('POST /v1/workspaces/:workspaceId/transactions/:transactionId/correct', {
  t: () => t,
  write: true,
  prepare: async (owner) => {
    const w = await moneyWorld(t, owner);
    const tx = await postExpense(owner, w);
    return {
      method: 'POST',
      url: `${w.base}/transactions/${tx.id}/correct`,
      payload: {
        baseVersion: tx.version,
        input: {
          type: 'expense',
          accountId: w.account.id,
          categoryId: w.fees.id,
          amount: '2000000',
          date: '2026-10-12',
        },
      },
      badPayload: { baseVersion: tx.version, input: { type: 'expense' } },
      assert: (res) => expect(res.json().transaction.amount).toBe('-2000000'),
    };
  },
});

sixPack('POST /v1/workspaces/:workspaceId/transactions/:transactionId/reverse', {
  t: () => t,
  write: true,
  prepare: async (owner) => {
    const w = await moneyWorld(t, owner);
    const tx = await postExpense(owner, w);
    return {
      method: 'POST',
      url: `${w.base}/transactions/${tx.id}/reverse`,
      payload: { baseVersion: tx.version },
      badPayload: { baseVersion: 0 },
      assert: (res) => expect(res.json().type).toBe('reversal'),
    };
  },
});

sixPack('POST /v1/workspaces/:workspaceId/transactions/:transactionId/unlock', {
  t: () => t,
  write: true,
  prepare: async (owner) => {
    const w = await moneyWorld(t, owner);
    const tx = await postExpense(owner, w, '1500000');
    const opening = (
      await t.app.inject({
        method: 'GET',
        url: `${w.base}/transactions?type=opening_balance`,
        headers: owner.auth,
      })
    ).json().items[0];
    const start = (
      await t.app.inject({
        method: 'POST',
        url: `${w.base}/accounts/${w.account.id}/reconciliations`,
        headers: { ...owner.auth, ...op() },
        payload: { statementDate: '2026-10-31', statementBalance: '8500000' },
      })
    ).json();
    await t.app.inject({
      method: 'POST',
      url: `/v1/workspaces/${owner.workspaceId}/reconciliations/${start.reconciliation.id}/tick`,
      headers: { ...owner.auth, ...op() },
      payload: { transactionIds: [opening.id, tx.id], cleared: true },
    });
    await t.app.inject({
      method: 'POST',
      url: `/v1/workspaces/${owner.workspaceId}/reconciliations/${start.reconciliation.id}/finish`,
      headers: { ...owner.auth, ...op() },
      payload: { adjust: false },
    });
    return {
      method: 'POST',
      url: `${w.base}/transactions/${tx.id}/unlock`,
      payload: { confirm: true },
      badPayload: { confirm: false },
      assert: (res) => expect(res.json().reconciled).toBe(false),
    };
  },
});

sixPack('POST /v1/workspaces/:workspaceId/transactions/bulk', {
  t: () => t,
  write: true,
  prepare: async (owner) => {
    const w = await moneyWorld(t, owner);
    const tx = await postExpense(owner, w);
    return {
      method: 'POST',
      url: `${w.base}/transactions/bulk`,
      payload: {
        transactionIds: [tx.id],
        action: { kind: 'categorize', categoryId: w.uncategorized.id },
      },
      badPayload: { transactionIds: [], action: { kind: 'delete' } },
      assert: (res) => expect(res.json().results[0].transactionId).toBe(tx.id),
    };
  },
});

sixPack('GET /v1/workspaces/:workspaceId/transactions/transfer-suggestions', {
  t: () => t,
  write: false,
  prepare: async (owner) => {
    const w = await moneyWorld(t, owner);
    return {
      method: 'GET',
      url: `${w.base}/transactions/transfer-suggestions`,
      assert: (res) => expect(res.json().suggestions).toEqual([]),
    };
  },
});

sixPack('POST /v1/workspaces/:workspaceId/transactions/link-transfer', {
  t: () => t,
  write: true,
  prepare: async (owner) => {
    const w = await moneyWorld(t, owner, { secondAccount: true });
    const out = (
      await t.app.inject({
        method: 'POST',
        url: `${w.base}/transactions`,
        headers: { ...owner.auth, ...op() },
        payload: {
          type: 'expense',
          accountId: w.account.id,
          categoryId: w.uncategorized.id,
          amount: '500000',
          date: '2026-10-10',
        },
      })
    ).json();
    const inn = (
      await t.app.inject({
        method: 'POST',
        url: `${w.base}/transactions`,
        headers: { ...owner.auth, ...op() },
        payload: {
          type: 'income',
          accountId: w.account2!.id,
          categoryId: w.otherIncome.id,
          amount: '500000',
          date: '2026-10-11',
        },
      })
    ).json();
    return {
      method: 'POST',
      url: `${w.base}/transactions/link-transfer`,
      payload: { outId: out.id, inId: inn.id },
      badPayload: { outId: out.id, inId: 'not-a-uuid' },
      assert: (res) => expect(res.json().type).toBe('transfer'),
    };
  },
});

sixPack('POST /v1/workspaces/:workspaceId/transactions/transfer-suggestions/dismiss', {
  t: () => t,
  write: true,
  prepare: async (owner) => {
    const w = await moneyWorld(t, owner, { secondAccount: true });
    const out = (
      await t.app.inject({
        method: 'POST',
        url: `${w.base}/transactions`,
        headers: { ...owner.auth, ...op() },
        payload: {
          type: 'expense',
          accountId: w.account.id,
          categoryId: w.uncategorized.id,
          amount: '250000',
          date: '2026-10-10',
        },
      })
    ).json();
    const inn = (
      await t.app.inject({
        method: 'POST',
        url: `${w.base}/transactions`,
        headers: { ...owner.auth, ...op() },
        payload: {
          type: 'income',
          accountId: w.account2!.id,
          categoryId: w.otherIncome.id,
          amount: '250000',
          date: '2026-10-11',
        },
      })
    ).json();
    return {
      method: 'POST',
      url: `${w.base}/transactions/transfer-suggestions/dismiss`,
      status: 204,
      payload: { outId: out.id, inId: inn.id },
      badPayload: { outId: out.id, inId: 'not-a-uuid' },
    };
  },
});
