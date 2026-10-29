import { afterAll, beforeAll, expect } from 'vitest';
import { sixPack } from '../../../../test/helpers/six-pack.js';
import { op, type SignedIn, startTestApp, type TestApp } from '../../../../test/helpers/test-app.js';

let t: TestApp;
beforeAll(async () => {
  t = await startTestApp();
});
afterAll(() => t.close());

async function broker(owner: SignedIn) {
  const base = `/v1/workspaces/${owner.workspaceId}`;
  const account = (
    await t.app.inject({
      method: 'POST',
      url: `${base}/accounts`,
      headers: { ...owner.auth, ...op() },
      payload: { type: 'investment', name: 'Stanbic Shares', openingBalance: '0', openingDate: '2026-10-01' },
    })
  ).json();
  return { base, account };
}

async function holding(owner: SignedIn) {
  const w = await broker(owner);
  const h = (
    await t.app.inject({
      method: 'POST',
      url: `${w.base}/investments/holdings`,
      headers: { ...owner.auth, ...op() },
      payload: { name: 'MTN Nigeria', type: 'stock', accountId: w.account.id, price: '23600' },
    })
  ).json();
  return { ...w, holding: h };
}

sixPack('POST /v1/workspaces/:workspaceId/investments/holdings', {
  t: () => t,
  write: true,
  prepare: async (owner) => {
    const w = await broker(owner);
    return {
      method: 'POST',
      url: `${w.base}/investments/holdings`,
      status: 201,
      payload: { name: 'MTN Nigeria', symbol: 'MTNN', type: 'stock', accountId: w.account.id },
      badPayload: { name: '', type: 'stock', accountId: w.account.id },
      assert: (res) => {
        expect(res.json()).toMatchObject({ name: 'MTN Nigeria', units: '0', value: '0', currency: 'NGN' });
      },
    };
  },
});

sixPack('GET /v1/workspaces/:workspaceId/investments', {
  t: () => t,
  write: false,
  prepare: async (owner) => {
    const w = await holding(owner);
    return {
      method: 'GET',
      url: `${w.base}/investments?range=1Y`,
      badUrl: `${w.base}/investments?range=2Y`,
      assert: (res) => {
        expect(res.json().holdings).toHaveLength(1);
        expect(res.json().series.at(-1).value).toBe('0');
      },
    };
  },
});

sixPack('GET /v1/workspaces/:workspaceId/investments/holdings/:holdingId', {
  t: () => t,
  write: false,
  prepare: async (owner) => {
    const w = await holding(owner);
    return {
      method: 'GET',
      url: `${w.base}/investments/holdings/${w.holding.id}`,
      badUrl: `${w.base}/investments/holdings/${w.holding.id}?range=5Y`,
      assert: (res) => {
        expect(res.json().prices).toEqual([expect.objectContaining({ price: '23600' })]);
      },
    };
  },
});

sixPack('PUT /v1/workspaces/:workspaceId/investments/prices', {
  t: () => t,
  write: true,
  prepare: async (owner) => {
    const w = await holding(owner);
    return {
      method: 'PUT',
      url: `${w.base}/investments/prices`,
      payload: { date: '2026-10-20', prices: [{ holdingId: w.holding.id, price: '24000' }] },
      badPayload: { date: '2026-10-20', prices: [{ holdingId: w.holding.id, price: '240.00' }] },
      assert: (res) => {
        expect(res.json().prices).toEqual([expect.objectContaining({ date: '2026-10-20', price: '24000' })]);
      },
    };
  },
});

sixPack('PUT /v1/workspaces/:workspaceId/exchange-rates', {
  t: () => t,
  write: true,
  prepare: async (owner) => ({
    method: 'PUT',
    url: `/v1/workspaces/${owner.workspaceId}/exchange-rates`,
    payload: { currency: 'USD', date: '2026-10-01', rate: '1550' },
    badPayload: { currency: 'USD', date: '2026-10-01', rate: '1,550' },
    assert: (res) => {
      expect(res.json()).toMatchObject({ currency: 'USD', rate: '1550', source: 'manual' });
    },
  }),
});

sixPack('GET /v1/workspaces/:workspaceId/exchange-rates', {
  t: () => t,
  write: false,
  prepare: async (owner) => ({
    method: 'GET',
    url: `/v1/workspaces/${owner.workspaceId}/exchange-rates`,
    badUrl: `/v1/workspaces/${owner.workspaceId}/exchange-rates?currency=usd`,
    assert: (res) => {
      expect(res.json()).toMatchObject({ currency: 'NGN', rates: [], needed: [] });
    },
  }),
});
