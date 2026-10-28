import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { op, startTestApp, type TestApp, twoWorkspaces } from '../../../../test/helpers/test-app.js';

let t: TestApp;
beforeAll(async () => {
  t = await startTestApp();
});
afterAll(() => t.close());

describe('categories, tags and payees over HTTP', () => {
  it('works end to end and stays inside the workspace', async () => {
    const { a: ada, b: bo } = await twoWorkspaces(t);
    const base = `/v1/workspaces/${ada.workspaceId}`;
    const tree = await t.app.inject({ method: 'GET', url: `${base}/categories`, headers: ada.auth });
    expect(tree.statusCode).toBe(200);
    const other = tree.json().groups.find((g: { name: string }) => g.name === 'Other');

    const made = await t.app.inject({
      method: 'POST',
      url: `${base}/categories`,
      headers: { ...ada.auth, ...op() },
      payload: { groupId: other.id, name: 'Food' },
    });
    expect(made.statusCode).toBe(201);
    expect(made.json()).toMatchObject({ name: 'Food', kind: 'expense', version: 1 });

    const tag = await t.app.inject({
      method: 'POST',
      url: `${base}/tags`,
      headers: { ...ada.auth, ...op() },
      payload: { name: 'Trip' },
    });
    expect(tag.statusCode).toBe(201);
    const payee = await t.app.inject({
      method: 'POST',
      url: `${base}/payees`,
      headers: { ...ada.auth, ...op() },
      payload: { name: 'Bolt' },
    });
    expect(payee.statusCode).toBe(201);
    const list = await t.app.inject({ method: 'GET', url: `${base}/payees?q=bo`, headers: ada.auth });
    expect(list.json().items).toHaveLength(1);

    const del = await t.app.inject({
      method: 'POST',
      url: `${base}/categories/${made.json().id}/delete`,
      headers: { ...ada.auth, ...op() },
      payload: { moveTo: null },
    });
    expect(del.statusCode).toBe(200);
    expect(del.json()).toMatchObject({ moved: 0 });

    expect((await t.app.inject({ method: 'GET', url: `${base}/categories`, headers: bo.auth })).statusCode).toBe(404);
    expect(
      (await t.app.inject({ method: 'POST', url: `${base}/tags`, headers: ada.auth, payload: { name: 'X' } }))
        .statusCode,
    ).toBe(400);
  });
});
