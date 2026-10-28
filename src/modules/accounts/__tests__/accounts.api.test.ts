import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
