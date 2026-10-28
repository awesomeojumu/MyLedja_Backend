import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { moneyWorld, sixPack } from '../../../../test/helpers/six-pack.js';
import { op, startTestApp, type TestApp, twoWorkspaces } from '../../../../test/helpers/test-app.js';

let t: TestApp;
beforeAll(async () => {
  t = await startTestApp();
});
afterAll(() => t.close());

describe('categories, tags and payees over HTTP (smoke)', () => {
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

sixPack('GET /v1/workspaces/:workspaceId/categories', {
  t: () => t,
  write: false,
  prepare: async (owner) => ({
    method: 'GET',
    url: `/v1/workspaces/${owner.workspaceId}/categories`,
    assert: (res) => {
      expect(res.json().groups.map((g: { name: string }) => g.name)).toEqual(
        expect.arrayContaining(['Income', 'Other']),
      );
    },
  }),
});

sixPack('POST /v1/workspaces/:workspaceId/categories', {
  t: () => t,
  write: true,
  prepare: async (owner) => {
    const w = await moneyWorld(t, owner);
    return {
      method: 'POST',
      url: `${w.base}/categories`,
      status: 201,
      payload: { groupId: w.other.id, name: `Cat ${Date.now()}` },
      badPayload: { groupId: w.other.id, name: ' ' },
      assert: (res) => expect(res.json()).toMatchObject({ kind: 'expense', version: 1 }),
    };
  },
});

sixPack('PATCH /v1/workspaces/:workspaceId/categories/:categoryId', {
  t: () => t,
  write: true,
  prepare: async (owner) => {
    const w = await moneyWorld(t, owner);
    const made = (
      await t.app.inject({
        method: 'POST',
        url: `${w.base}/categories`,
        headers: { ...owner.auth, ...op() },
        payload: { groupId: w.other.id, name: `Patch ${Date.now()}` },
      })
    ).json();
    return {
      method: 'PATCH',
      url: `${w.base}/categories/${made.id}`,
      payload: { baseVersion: made.version, name: `Renamed ${Date.now()}` },
      badPayload: { baseVersion: made.version, name: ' ' },
      assert: (res) => expect(res.json().name).toMatch(/^Renamed /),
    };
  },
});

sixPack('POST /v1/workspaces/:workspaceId/categories/:categoryId/delete', {
  t: () => t,
  write: true,
  prepare: async (owner) => {
    const w = await moneyWorld(t, owner);
    const made = (
      await t.app.inject({
        method: 'POST',
        url: `${w.base}/categories`,
        headers: { ...owner.auth, ...op() },
        payload: { groupId: w.other.id, name: `Del ${Date.now()}` },
      })
    ).json();
    return {
      method: 'POST',
      url: `${w.base}/categories/${made.id}/delete`,
      payload: { moveTo: null },
      badPayload: { moveTo: 'not-a-uuid' },
      assert: (res) => expect(res.json()).toMatchObject({ categoryId: made.id, moved: 0 }),
    };
  },
});

sixPack('POST /v1/workspaces/:workspaceId/categories/undo/:undoId', {
  t: () => t,
  write: true,
  prepare: async (owner) => {
    const w = await moneyWorld(t, owner);
    const made = (
      await t.app.inject({
        method: 'POST',
        url: `${w.base}/categories`,
        headers: { ...owner.auth, ...op() },
        payload: { groupId: w.other.id, name: `UndoCat ${Date.now()}` },
      })
    ).json();
    const del = (
      await t.app.inject({
        method: 'POST',
        url: `${w.base}/categories/${made.id}/delete`,
        headers: { ...owner.auth, ...op() },
        payload: { moveTo: null },
      })
    ).json();
    return {
      method: 'POST',
      url: `${w.base}/categories/undo/${del.undoId}`,
      badUrl: `${w.base}/categories/undo/not-a-uuid`,
      assert: (res) => expect(res.json()).toMatchObject({ id: made.id, name: made.name }),
    };
  },
});

sixPack('POST /v1/workspaces/:workspaceId/category-groups', {
  t: () => t,
  write: true,
  prepare: async (owner) => ({
    method: 'POST',
    url: `/v1/workspaces/${owner.workspaceId}/category-groups`,
    status: 201,
    payload: { name: `Group ${Date.now()}`, kind: 'expense' },
    badPayload: { name: ' ', kind: 'expense' },
    assert: (res) => expect(res.json()).toMatchObject({ kind: 'expense' }),
  }),
});

sixPack('PATCH /v1/workspaces/:workspaceId/category-groups/:groupId', {
  t: () => t,
  write: true,
  prepare: async (owner) => {
    const base = `/v1/workspaces/${owner.workspaceId}`;
    const group = (
      await t.app.inject({
        method: 'POST',
        url: `${base}/category-groups`,
        headers: { ...owner.auth, ...op() },
        payload: { name: `G ${Date.now()}`, kind: 'expense' },
      })
    ).json();
    return {
      method: 'PATCH',
      url: `${base}/category-groups/${group.id}`,
      payload: { baseVersion: group.version, name: `G2 ${Date.now()}` },
      badPayload: { baseVersion: group.version, name: ' ' },
      assert: (res) => expect(res.json().name).toMatch(/^G2 /),
    };
  },
});

sixPack('DELETE /v1/workspaces/:workspaceId/category-groups/:groupId', {
  t: () => t,
  write: true,
  prepare: async (owner) => {
    const base = `/v1/workspaces/${owner.workspaceId}`;
    const group = (
      await t.app.inject({
        method: 'POST',
        url: `${base}/category-groups`,
        headers: { ...owner.auth, ...op() },
        payload: { name: `Empty ${Date.now()}`, kind: 'expense' },
      })
    ).json();
    return {
      method: 'DELETE',
      url: `${base}/category-groups/${group.id}`,
      status: 204,
      badUrl: `${base}/category-groups/not-a-uuid`,
    };
  },
});

sixPack('GET /v1/workspaces/:workspaceId/tags', {
  t: () => t,
  write: false,
  prepare: async (owner) => ({
    method: 'GET',
    url: `/v1/workspaces/${owner.workspaceId}/tags`,
    assert: (res) => expect(res.json().tags).toEqual([]),
  }),
});

sixPack('POST /v1/workspaces/:workspaceId/tags', {
  t: () => t,
  write: true,
  prepare: async (owner) => ({
    method: 'POST',
    url: `/v1/workspaces/${owner.workspaceId}/tags`,
    status: 201,
    payload: { name: `Tag ${Date.now()}` },
    badPayload: { name: ' ' },
    assert: (res) => expect(res.json().name).toMatch(/^Tag /),
  }),
});

sixPack('PATCH /v1/workspaces/:workspaceId/tags/:tagId', {
  t: () => t,
  write: true,
  prepare: async (owner) => {
    const base = `/v1/workspaces/${owner.workspaceId}`;
    const tag = (
      await t.app.inject({
        method: 'POST',
        url: `${base}/tags`,
        headers: { ...owner.auth, ...op() },
        payload: { name: `T ${Date.now()}` },
      })
    ).json();
    return {
      method: 'PATCH',
      url: `${base}/tags/${tag.id}`,
      payload: { baseVersion: tag.version, name: `T2 ${Date.now()}` },
      badPayload: { baseVersion: tag.version, name: ' ' },
      assert: (res) => expect(res.json().name).toMatch(/^T2 /),
    };
  },
});

sixPack('DELETE /v1/workspaces/:workspaceId/tags/:tagId', {
  t: () => t,
  write: true,
  prepare: async (owner) => {
    const base = `/v1/workspaces/${owner.workspaceId}`;
    const tag = (
      await t.app.inject({
        method: 'POST',
        url: `${base}/tags`,
        headers: { ...owner.auth, ...op() },
        payload: { name: `DelTag ${Date.now()}` },
      })
    ).json();
    return {
      method: 'DELETE',
      url: `${base}/tags/${tag.id}`,
      status: 204,
      badUrl: `${base}/tags/not-a-uuid`,
    };
  },
});

sixPack('GET /v1/workspaces/:workspaceId/payees', {
  t: () => t,
  write: false,
  prepare: async (owner) => ({
    method: 'GET',
    url: `/v1/workspaces/${owner.workspaceId}/payees`,
    badUrl: `/v1/workspaces/${owner.workspaceId}/payees?limit=0`,
    assert: (res) => expect(res.json().items).toEqual([]),
  }),
});

sixPack('GET /v1/workspaces/:workspaceId/payees/:payeeId', {
  t: () => t,
  write: false,
  prepare: async (owner) => {
    const base = `/v1/workspaces/${owner.workspaceId}`;
    const payee = (
      await t.app.inject({
        method: 'POST',
        url: `${base}/payees`,
        headers: { ...owner.auth, ...op() },
        payload: { name: `P ${Date.now()}` },
      })
    ).json();
    return {
      method: 'GET',
      url: `${base}/payees/${payee.id}`,
      badUrl: `${base}/payees/not-a-uuid`,
      assert: (res) => expect(res.json().id).toBe(payee.id),
    };
  },
});

sixPack('POST /v1/workspaces/:workspaceId/payees', {
  t: () => t,
  write: true,
  prepare: async (owner) => ({
    method: 'POST',
    url: `/v1/workspaces/${owner.workspaceId}/payees`,
    status: 201,
    payload: { name: `Payee ${Date.now()}` },
    badPayload: { name: ' ' },
    assert: (res) => expect(res.json().name).toMatch(/^Payee /),
  }),
});

sixPack('PATCH /v1/workspaces/:workspaceId/payees/:payeeId', {
  t: () => t,
  write: true,
  prepare: async (owner) => {
    const base = `/v1/workspaces/${owner.workspaceId}`;
    const payee = (
      await t.app.inject({
        method: 'POST',
        url: `${base}/payees`,
        headers: { ...owner.auth, ...op() },
        payload: { name: `P ${Date.now()}` },
      })
    ).json();
    return {
      method: 'PATCH',
      url: `${base}/payees/${payee.id}`,
      payload: { baseVersion: payee.version, name: `P2 ${Date.now()}` },
      badPayload: { baseVersion: payee.version, name: ' ' },
      assert: (res) => expect(res.json().name).toMatch(/^P2 /),
    };
  },
});

sixPack('POST /v1/workspaces/:workspaceId/payees/merge', {
  t: () => t,
  write: true,
  prepare: async (owner) => {
    const base = `/v1/workspaces/${owner.workspaceId}`;
    const a = (
      await t.app.inject({
        method: 'POST',
        url: `${base}/payees`,
        headers: { ...owner.auth, ...op() },
        payload: { name: `Keep ${Date.now()}` },
      })
    ).json();
    const b = (
      await t.app.inject({
        method: 'POST',
        url: `${base}/payees`,
        headers: { ...owner.auth, ...op() },
        payload: { name: `Merge ${Date.now()}` },
      })
    ).json();
    return {
      method: 'POST',
      url: `${base}/payees/merge`,
      payload: { keepId: a.id, mergeIds: [b.id] },
      badPayload: { keepId: a.id, mergeIds: [] },
      assert: (res) => expect(res.json()).toMatchObject({ payee: { id: a.id }, moved: 0 }),
    };
  },
});

sixPack('POST /v1/workspaces/:workspaceId/payees/merges/:mergeId/undo', {
  t: () => t,
  write: true,
  prepare: async (owner) => {
    const base = `/v1/workspaces/${owner.workspaceId}`;
    const a = (
      await t.app.inject({
        method: 'POST',
        url: `${base}/payees`,
        headers: { ...owner.auth, ...op() },
        payload: { name: `KeepU ${Date.now()}` },
      })
    ).json();
    const b = (
      await t.app.inject({
        method: 'POST',
        url: `${base}/payees`,
        headers: { ...owner.auth, ...op() },
        payload: { name: `MergeU ${Date.now()}` },
      })
    ).json();
    const merged = (
      await t.app.inject({
        method: 'POST',
        url: `${base}/payees/merge`,
        headers: { ...owner.auth, ...op() },
        payload: { keepId: a.id, mergeIds: [b.id] },
      })
    ).json();
    return {
      method: 'POST',
      url: `${base}/payees/merges/${merged.mergeId}/undo`,
      badUrl: `${base}/payees/merges/not-a-uuid/undo`,
      assert: (res) => expect(res.json().payees.length).toBeGreaterThanOrEqual(1),
    };
  },
});
