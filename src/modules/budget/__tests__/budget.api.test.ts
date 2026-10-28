import { afterAll, beforeAll, expect } from 'vitest';
import { moneyWorld, sixPack } from '../../../../test/helpers/six-pack.js';
import { op, startTestApp, type TestApp } from '../../../../test/helpers/test-app.js';

let t: TestApp;
beforeAll(async () => {
  t = await startTestApp();
});
afterAll(() => t.close());

const month = '2026-10';

sixPack('GET /v1/workspaces/:workspaceId/budget/:month', {
  t: () => t,
  write: false,
  prepare: async (owner) => {
    await moneyWorld(t, owner);
    return {
      method: 'GET',
      url: `/v1/workspaces/${owner.workspaceId}/budget/${month}`,
      badUrl: `/v1/workspaces/${owner.workspaceId}/budget/2026-13`,
      assert: (res) => {
        expect(res.json().months).toHaveLength(1);
        expect(res.json().months[0].month).toBe(month);
      },
    };
  },
});

sixPack('PUT /v1/workspaces/:workspaceId/budget/:month/categories/:categoryId', {
  t: () => t,
  write: true,
  prepare: async (owner) => {
    const w = await moneyWorld(t, owner);
    return {
      method: 'PUT',
      url: `${w.base}/budget/${month}/categories/${w.fees.id}`,
      payload: { assigned: '5000000' },
      badPayload: { assigned: '50.00' },
      assert: (res) => {
        const cat = res.json().categories.find((c: { categoryId: string }) => c.categoryId === w.fees.id);
        expect(cat.assigned).toBe('5000000');
      },
    };
  },
});

sixPack('POST /v1/workspaces/:workspaceId/budget/:month/move', {
  t: () => t,
  write: true,
  prepare: async (owner) => {
    const w = await moneyWorld(t, owner);
    await t.app.inject({
      method: 'PUT',
      url: `${w.base}/budget/${month}/categories/${w.fees.id}`,
      headers: { ...owner.auth, ...op() },
      payload: { assigned: '8000000' },
    });
    await t.app.inject({
      method: 'PUT',
      url: `${w.base}/budget/${month}/categories/${w.uncategorized.id}`,
      headers: { ...owner.auth, ...op() },
      payload: { assigned: '1000000' },
    });
    return {
      method: 'POST',
      url: `${w.base}/budget/${month}/move`,
      payload: { fromCategoryId: w.fees.id, toCategoryId: w.uncategorized.id, amount: '2000000' },
      badPayload: { fromCategoryId: w.fees.id, toCategoryId: w.uncategorized.id, amount: '2.00' },
      assert: (res) => {
        const from = res.json().categories.find((c: { categoryId: string }) => c.categoryId === w.fees.id);
        const to = res.json().categories.find((c: { categoryId: string }) => c.categoryId === w.uncategorized.id);
        expect(from.assigned).toBe('6000000');
        expect(to.assigned).toBe('3000000');
      },
    };
  },
});

sixPack('POST /v1/workspaces/:workspaceId/budget/:month/cover', {
  t: () => t,
  write: true,
  prepare: async (owner) => {
    const w = await moneyWorld(t, owner);
    await t.db
      .collection('workspaces')
      .updateOne({ _id: owner.workspaceId as never }, { $set: { budgetStyle: 'envelope' } });
    await t.app.inject({
      method: 'POST',
      url: `${w.base}/transactions`,
      headers: { ...owner.auth, ...op() },
      payload: {
        type: 'income',
        accountId: w.account.id,
        categoryId: w.otherIncome.id,
        amount: '20000000',
        date: '2026-10-05',
      },
    });
    await t.app.inject({
      method: 'PUT',
      url: `${w.base}/budget/${month}/categories/${w.fees.id}`,
      headers: { ...owner.auth, ...op() },
      payload: { assigned: '1000000' },
    });
    await t.app.inject({
      method: 'PUT',
      url: `${w.base}/budget/${month}/categories/${w.uncategorized.id}`,
      headers: { ...owner.auth, ...op() },
      payload: { assigned: '5000000' },
    });
    await t.app.inject({
      method: 'POST',
      url: `${w.base}/transactions`,
      headers: { ...owner.auth, ...op() },
      payload: {
        type: 'expense',
        accountId: w.account.id,
        categoryId: w.fees.id,
        amount: '2500000',
        date: '2026-10-12',
      },
    });
    return {
      method: 'POST',
      url: `${w.base}/budget/${month}/cover`,
      payload: {
        covers: [{ categoryId: w.fees.id, fromCategoryId: w.uncategorized.id, amount: '1500000' }],
      },
      badPayload: { covers: [] },
      assert: (res) => {
        const fees = res.json().categories.find((c: { categoryId: string }) => c.categoryId === w.fees.id);
        expect(BigInt(fees.available)).toBeGreaterThanOrEqual(0n);
      },
    };
  },
});
