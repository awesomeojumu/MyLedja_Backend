import { afterAll, beforeAll, expect } from 'vitest';
import { moneyWorld, sixPack } from '../../../../test/helpers/six-pack.js';
import { op, startTestApp, type TestApp } from '../../../../test/helpers/test-app.js';

let t: TestApp;
beforeAll(async () => {
  t = await startTestApp();
});
afterAll(() => t.close());

async function expenseAndOpening(owner: { auth: Record<string, string> }, w: Awaited<ReturnType<typeof moneyWorld>>) {
  const tx = (
    await t.app.inject({
      method: 'POST',
      url: `${w.base}/transactions`,
      headers: { ...owner.auth, ...op() },
      payload: {
        type: 'expense',
        accountId: w.account.id,
        categoryId: w.fees.id,
        amount: '1500000',
        date: '2026-10-05',
      },
    })
  ).json();
  const opening = (
    await t.app.inject({
      method: 'GET',
      url: `${w.base}/transactions?type=opening_balance`,
      headers: owner.auth,
    })
  ).json().items[0];
  return { tx, opening };
}

async function startReconcile(owner: { auth: Record<string, string> }, w: Awaited<ReturnType<typeof moneyWorld>>) {
  return (
    await t.app.inject({
      method: 'POST',
      url: `${w.base}/accounts/${w.account.id}/reconciliations`,
      headers: { ...owner.auth, ...op() },
      payload: { statementDate: '2026-10-31', statementBalance: '8500000' },
    })
  ).json();
}

sixPack('POST /v1/workspaces/:workspaceId/accounts/:accountId/reconciliations', {
  t: () => t,
  write: true,
  prepare: async (owner) => {
    const w = await moneyWorld(t, owner);
    await expenseAndOpening(owner, w);
    return {
      method: 'POST',
      url: `${w.base}/accounts/${w.account.id}/reconciliations`,
      status: 201,
      payload: { statementDate: '2026-10-31', statementBalance: '8500000' },
      badPayload: { statementDate: 'bad', statementBalance: '8500000' },
      assert: (res) => expect(res.json().reconciliation.status).toBe('in_progress'),
    };
  },
});

sixPack('GET /v1/workspaces/:workspaceId/accounts/:accountId/reconciliations', {
  t: () => t,
  write: false,
  prepare: async (owner) => {
    const w = await moneyWorld(t, owner);
    await expenseAndOpening(owner, w);
    await startReconcile(owner, w);
    return {
      method: 'GET',
      url: `${w.base}/accounts/${w.account.id}/reconciliations`,
      badUrl: `${w.base}/accounts/not-a-uuid/reconciliations`,
      assert: (res) => expect(res.json().reconciliations.length).toBeGreaterThanOrEqual(1),
    };
  },
});

sixPack('GET /v1/workspaces/:workspaceId/reconciliations/:reconciliationId', {
  t: () => t,
  write: false,
  prepare: async (owner) => {
    const w = await moneyWorld(t, owner);
    await expenseAndOpening(owner, w);
    const start = await startReconcile(owner, w);
    return {
      method: 'GET',
      url: `/v1/workspaces/${owner.workspaceId}/reconciliations/${start.reconciliation.id}`,
      badUrl: `/v1/workspaces/${owner.workspaceId}/reconciliations/not-a-uuid`,
      assert: (res) => expect(res.json().reconciliation.id).toBe(start.reconciliation.id),
    };
  },
});

sixPack('POST /v1/workspaces/:workspaceId/reconciliations/:reconciliationId/tick', {
  t: () => t,
  write: true,
  prepare: async (owner) => {
    const w = await moneyWorld(t, owner);
    const { tx, opening } = await expenseAndOpening(owner, w);
    const start = await startReconcile(owner, w);
    return {
      method: 'POST',
      url: `/v1/workspaces/${owner.workspaceId}/reconciliations/${start.reconciliation.id}/tick`,
      payload: { transactionIds: [opening.id, tx.id], cleared: true },
      badPayload: { transactionIds: [], cleared: true },
      assert: (res) => expect(res.json().reconciliation.difference).toBe('0'),
    };
  },
});

sixPack('POST /v1/workspaces/:workspaceId/reconciliations/:reconciliationId/finish', {
  t: () => t,
  write: true,
  prepare: async (owner) => {
    const w = await moneyWorld(t, owner);
    const { tx, opening } = await expenseAndOpening(owner, w);
    const start = await startReconcile(owner, w);
    await t.app.inject({
      method: 'POST',
      url: `/v1/workspaces/${owner.workspaceId}/reconciliations/${start.reconciliation.id}/tick`,
      headers: { ...owner.auth, ...op() },
      payload: { transactionIds: [opening.id, tx.id], cleared: true },
    });
    return {
      method: 'POST',
      url: `/v1/workspaces/${owner.workspaceId}/reconciliations/${start.reconciliation.id}/finish`,
      payload: { adjust: false },
      badPayload: { adjust: 'nope' },
      assert: (res) => expect(res.json().reconciliation.status).toBe('finished'),
    };
  },
});

sixPack('POST /v1/workspaces/:workspaceId/reconciliations/:reconciliationId/cancel', {
  t: () => t,
  write: true,
  prepare: async (owner) => {
    const w = await moneyWorld(t, owner);
    await expenseAndOpening(owner, w);
    const start = await startReconcile(owner, w);
    return {
      method: 'POST',
      url: `/v1/workspaces/${owner.workspaceId}/reconciliations/${start.reconciliation.id}/cancel`,
      badUrl: `/v1/workspaces/${owner.workspaceId}/reconciliations/not-a-uuid/cancel`,
      assert: (res) => expect(res.json().status).toBe('cancelled'),
    };
  },
});
