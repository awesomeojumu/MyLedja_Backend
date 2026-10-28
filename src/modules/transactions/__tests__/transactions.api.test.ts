import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { op, signUp, startTestApp, type TestApp } from '../../../../test/helpers/test-app.js';

let t: TestApp;
beforeAll(async () => {
  t = await startTestApp();
});
afterAll(() => t.close());

describe('transactions API', () => {
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
