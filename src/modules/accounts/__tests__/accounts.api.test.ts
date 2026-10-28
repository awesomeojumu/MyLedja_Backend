import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { moneyWorld, sixPack } from '../../../../test/helpers/six-pack.js';
import { op, signUp, startTestApp, type TestApp } from '../../../../test/helpers/test-app.js';

let t: TestApp;
beforeAll(async () => {
  t = await startTestApp();
});
afterAll(() => t.close());

describe('GET /v1/institutions', () => {
  it('is public and cacheable, with logos null until uploaded', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/v1/institutions' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('public, max-age=86400');
    const body = res.json();
    expect(body.version).toMatch(/^[0-9a-f]{12}$/);
    expect(body.institutions.find((i: { id: string }) => i.id === 'gtbank')).toEqual({
      id: 'gtbank',
      name: 'GTBank',
      kind: 'bank',
      logoUrl: null,
      aliases: ['GTCO', 'Guaranty Trust Bank'],
    });
    expect(new Set(body.institutions.map((i: { id: string }) => i.id)).size).toBe(body.institutions.length);
  });
});

describe('Welcome setup creates the real accounts and categories', () => {
  it('once, even when sent again', async () => {
    const ada = await signUp(t);
    const base = `/v1/workspaces/${ada.workspaceId}`;
    const body = {
      workspaceName: 'Home',
      currency: 'NGN',
      weekStart: 'monday',
      accounts: [
        { name: 'GTBank Current', type: 'bank', openingBalance: '81230000', openingDate: '2026-10-01' },
        { name: 'Card', type: 'card', openingBalance: '4500000', openingDate: '2026-10-01' },
      ],
      categories: [{ key: 'rent', group: 'Home', name: 'Rent' }],
      budgetStyle: 'envelope',
      monthlyTakeHome: null,
      skippedSteps: [],
    };
    for (let i = 0; i < 2; i++) {
      const res = await t.app.inject({
        method: 'POST',
        url: `${base}/setup`,
        headers: { ...ada.auth, ...op() },
        payload: body,
      });
      expect(res.statusCode).toBe(200);
    }
    const list = (await t.app.inject({ method: 'GET', url: `${base}/accounts`, headers: ada.auth })).json();
    expect(list.accounts.map((a: { name: string }) => a.name)).toEqual(['GTBank Current', 'Card']);
    expect(list.netWorth.amount).toBe('76730000');
    const cats = (await t.app.inject({ method: 'GET', url: `${base}/categories`, headers: ada.auth })).json();
    expect(cats.categories.filter((c: { name: string }) => c.name === 'Rent')).toHaveLength(1);

    const created = await t.app.inject({
      method: 'POST',
      url: `${base}/accounts`,
      headers: { ...ada.auth, ...op() },
      payload: { type: 'wallet', name: 'OPay', institution: 'opay', openingDate: '2026-10-02' },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ balance: '0', group: 'cash_bank' });
  });
});

sixPack('GET /v1/workspaces/:workspaceId/accounts', {
  t: () => t,
  write: false,
  prepare: async (owner) => {
    await moneyWorld(t, owner);
    return {
      method: 'GET',
      url: `/v1/workspaces/${owner.workspaceId}/accounts`,
      assert: (res) => {
        expect(res.json().accounts.length).toBeGreaterThanOrEqual(1);
        expect(res.json().netWorth).toMatchObject({ amount: expect.any(String) });
      },
    };
  },
});

sixPack('POST /v1/workspaces/:workspaceId/accounts', {
  t: () => t,
  write: true,
  prepare: async (owner) => ({
    method: 'POST',
    url: `/v1/workspaces/${owner.workspaceId}/accounts`,
    status: 201,
    payload: { type: 'cash', name: `Cash ${Date.now()}`, openingBalance: '50000', openingDate: '2026-10-01' },
    badPayload: { type: 'cash', name: ' ', openingDate: '2026-10-01' },
    assert: (res) => {
      expect(res.json()).toMatchObject({ type: 'cash', balance: '50000', group: 'cash_bank' });
    },
  }),
});

sixPack('GET /v1/workspaces/:workspaceId/accounts/:accountId', {
  t: () => t,
  write: false,
  prepare: async (owner) => {
    const w = await moneyWorld(t, owner);
    return {
      method: 'GET',
      url: `${w.base}/accounts/${w.account.id}`,
      badUrl: `${w.base}/accounts/not-a-uuid`,
      assert: (res) => expect(res.json().id).toBe(w.account.id),
    };
  },
});

sixPack('PATCH /v1/workspaces/:workspaceId/accounts/:accountId', {
  t: () => t,
  write: true,
  prepare: async (owner) => {
    const w = await moneyWorld(t, owner);
    return {
      method: 'PATCH',
      url: `${w.base}/accounts/${w.account.id}`,
      payload: { baseVersion: w.account.version, name: `Renamed ${Date.now()}` },
      badPayload: { baseVersion: w.account.version, name: ' ' },
      assert: (res) => expect(res.json().name).toMatch(/^Renamed /),
    };
  },
});

sixPack('POST /v1/workspaces/:workspaceId/accounts/:accountId/archive', {
  t: () => t,
  write: true,
  prepare: async (owner) => {
    const w = await moneyWorld(t, owner, { secondAccount: true });
    return {
      method: 'POST',
      url: `${w.base}/accounts/${w.account.id}/archive`,
      payload: { baseVersion: w.account.version, moveBalanceTo: w.account2!.id, date: '2026-10-15' },
      badPayload: { baseVersion: w.account.version, moveBalanceTo: w.account2!.id, date: 'bad' },
      assert: (res) => expect(res.json()).toMatchObject({ archived: true }),
    };
  },
});

sixPack('POST /v1/workspaces/:workspaceId/accounts/:accountId/restore', {
  t: () => t,
  write: true,
  prepare: async (owner) => {
    const w = await moneyWorld(t, owner);
    const archived = await t.app.inject({
      method: 'POST',
      url: `${w.base}/accounts/${w.account.id}/archive`,
      headers: { ...owner.auth, ...op() },
      payload: { baseVersion: w.account.version, moveBalanceTo: null, date: '2026-10-15' },
    });
    expect(archived.statusCode).toBe(200);
    return {
      method: 'POST',
      url: `${w.base}/accounts/${w.account.id}/restore`,
      assert: (res) => expect(res.json()).toMatchObject({ archived: false }),
    };
  },
});

sixPack('POST /v1/workspaces/:workspaceId/accounts/:accountId/value', {
  t: () => t,
  write: true,
  prepare: async (owner) => {
    const base = `/v1/workspaces/${owner.workspaceId}`;
    const stocks = (
      await t.app.inject({
        method: 'POST',
        url: `${base}/accounts`,
        headers: { ...owner.auth, ...op() },
        payload: {
          type: 'investment',
          name: `Stocks ${Date.now()}`,
          openingBalance: '1000000',
          openingDate: '2026-10-01',
        },
      })
    ).json();
    return {
      method: 'POST',
      url: `${base}/accounts/${stocks.id}/value`,
      payload: { value: '1250000', date: '2026-10-20' },
      badPayload: { value: '12.50', date: '2026-10-20' },
      assert: (res) => expect(res.json().balance).toBe('1250000'),
    };
  },
});

sixPack('PUT /v1/workspaces/:workspaceId/accounts/order', {
  t: () => t,
  write: true,
  prepare: async (owner) => {
    const w = await moneyWorld(t, owner, { secondAccount: true });
    return {
      method: 'PUT',
      url: `${w.base}/accounts/order`,
      payload: { accountIds: [w.account2!.id, w.account.id] },
      badPayload: { accountIds: [] },
      assert: (res) => {
        const ids = res.json().accounts.map((a: { id: string }) => a.id);
        expect(ids[0]).toBe(w.account2!.id);
        expect(ids[1]).toBe(w.account.id);
      },
    };
  },
});
