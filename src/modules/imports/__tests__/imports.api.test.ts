import { afterAll, beforeAll, expect } from 'vitest';
import { moneyWorld, sixPack } from '../../../../test/helpers/six-pack.js';
import { op, startTestApp, type TestApp } from '../../../../test/helpers/test-app.js';

let t: TestApp;
beforeAll(async () => {
  t = await startTestApp();
});
afterAll(() => t.close());

const mapping = {
  date: 0,
  amount: 1,
  moneyIn: null,
  moneyOut: null,
  description: 2,
  payee: null,
  notes: null,
  dateFormat: 'YYYY-MM-DD' as const,
  hasHeader: true,
};

const sampleCsv = ['Date,Amount,Description', '2026-10-08,-5000.00,Uber', '2026-10-09,-2000.00,Fuel'].join('\n');

async function uploadMapped(owner: { auth: Record<string, string> }, w: Awaited<ReturnType<typeof moneyWorld>>) {
  const uploaded = (
    await t.app.inject({
      method: 'POST',
      url: `${w.base}/imports`,
      headers: { ...owner.auth, ...op() },
      payload: { accountId: w.account.id, fileName: 'gtb.csv', content: sampleCsv },
    })
  ).json();
  const mapped = (
    await t.app.inject({
      method: 'POST',
      url: `${w.base}/imports/${uploaded.id}/map`,
      headers: { ...owner.auth, ...op() },
      payload: { mapping },
    })
  ).json();
  return mapped;
}

sixPack('POST /v1/workspaces/:workspaceId/imports', {
  t: () => t,
  write: true,
  prepare: async (owner) => {
    const w = await moneyWorld(t, owner);
    return {
      method: 'POST',
      url: `${w.base}/imports`,
      status: 201,
      payload: { accountId: w.account.id, fileName: 'gtb.csv', content: sampleCsv },
      badPayload: { accountId: w.account.id, fileName: 'gtb.csv', content: '' },
      assert: (res) => expect(res.json()).toMatchObject({ status: 'uploaded', fileName: 'gtb.csv' }),
    };
  },
});

sixPack('GET /v1/workspaces/:workspaceId/imports/:importId', {
  t: () => t,
  write: false,
  prepare: async (owner) => {
    const w = await moneyWorld(t, owner);
    const uploaded = (
      await t.app.inject({
        method: 'POST',
        url: `${w.base}/imports`,
        headers: { ...owner.auth, ...op() },
        payload: { accountId: w.account.id, fileName: 'gtb.csv', content: sampleCsv },
      })
    ).json();
    return {
      method: 'GET',
      url: `${w.base}/imports/${uploaded.id}`,
      badUrl: `${w.base}/imports/not-a-uuid`,
      assert: (res) => expect(res.json().id).toBe(uploaded.id),
    };
  },
});

sixPack('POST /v1/workspaces/:workspaceId/imports/:importId/map', {
  t: () => t,
  write: true,
  prepare: async (owner) => {
    const w = await moneyWorld(t, owner);
    const uploaded = (
      await t.app.inject({
        method: 'POST',
        url: `${w.base}/imports`,
        headers: { ...owner.auth, ...op() },
        payload: { accountId: w.account.id, fileName: 'gtb.csv', content: sampleCsv },
      })
    ).json();
    return {
      method: 'POST',
      url: `${w.base}/imports/${uploaded.id}/map`,
      payload: { mapping },
      badPayload: { mapping: { ...mapping, dateFormat: 'nope' } },
      assert: (res) => expect(res.json()).toMatchObject({ status: 'mapped' }),
    };
  },
});

sixPack('POST /v1/workspaces/:workspaceId/imports/:importId/post', {
  t: () => t,
  write: true,
  prepare: async (owner) => {
    const w = await moneyWorld(t, owner);
    const mapped = await uploadMapped(owner, w);
    return {
      method: 'POST',
      url: `${w.base}/imports/${mapped.id}/post`,
      payload: {
        rows: mapped.rows.map((r: { index: number; include: boolean }) => ({
          index: r.index,
          include: r.include,
          categoryId: w.fees.id,
        })),
      },
      badPayload: { rows: [{ index: 0, include: true, categoryId: 'not-a-uuid' }] },
      assert: (res) => {
        expect(res.json().status).toBe('posted');
        expect(res.json().counts.posted).toBeGreaterThanOrEqual(1);
      },
    };
  },
});

sixPack('POST /v1/workspaces/:workspaceId/imports/:importId/undo', {
  t: () => t,
  write: true,
  prepare: async (owner) => {
    const w = await moneyWorld(t, owner);
    const mapped = await uploadMapped(owner, w);
    await t.app.inject({
      method: 'POST',
      url: `${w.base}/imports/${mapped.id}/post`,
      headers: { ...owner.auth, ...op() },
      payload: {
        rows: mapped.rows.map((r: { index: number; include: boolean }) => ({
          index: r.index,
          include: r.include,
          categoryId: w.fees.id,
        })),
      },
    });
    return {
      method: 'POST',
      url: `${w.base}/imports/${mapped.id}/undo`,
      badUrl: `${w.base}/imports/not-a-uuid/undo`,
      assert: (res) => expect(res.json().status).toBe('undone'),
    };
  },
});
