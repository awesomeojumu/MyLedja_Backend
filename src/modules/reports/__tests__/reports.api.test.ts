import { afterAll, beforeAll, expect } from 'vitest';
import { moneyWorld, sixPack } from '../../../../test/helpers/six-pack.js';
import { startTestApp, type TestApp } from '../../../../test/helpers/test-app.js';

let t: TestApp;
beforeAll(async () => {
  t = await startTestApp();
});
afterAll(() => t.close());

const ws = (id: string) => `/v1/workspaces/${id}`;

sixPack('POST /v1/workspaces/:workspaceId/reports/run', {
  t: () => t,
  write: false,
  prepare: async (owner) => {
    await moneyWorld(t, owner);
    return {
      method: 'POST',
      url: `${ws(owner.workspaceId)}/reports/run`,
      payload: { kind: 'income_vs_expenses', from: '2026-07-01', to: '2026-10-31' },
      badPayload: { kind: 'tax_summary', from: '2026-07-01', to: '2026-10-31' },
      assert: (res) => {
        const body = res.json();
        expect(body.table.columns.map((c: { key: string }) => c.key)).toEqual(['income', 'spending']);
        expect(body.table.rows).toHaveLength(4);
      },
    };
  },
});

sixPack('GET /v1/workspaces/:workspaceId/cash-flow', {
  t: () => t,
  write: false,
  prepare: async (owner) => {
    await moneyWorld(t, owner);
    return {
      method: 'GET',
      url: `${ws(owner.workspaceId)}/cash-flow?from=2026-10-01&to=2026-10-31`,
      badUrl: `${ws(owner.workspaceId)}/cash-flow?from=2026-10-01`,
      assert: (res) => {
        expect(res.json().tiles).toMatchObject({ in: '0' });
      },
    };
  },
});

sixPack('GET /v1/workspaces/:workspaceId/health/:month', {
  t: () => t,
  write: false,
  prepare: async (owner) => {
    await moneyWorld(t, owner);
    return {
      method: 'GET',
      url: `${ws(owner.workspaceId)}/health/2026-10`,
      badUrl: `${ws(owner.workspaceId)}/health/2026-13`,
      assert: (res) => {
        expect(res.json()).toMatchObject({ ready: false, score: null });
      },
    };
  },
});

sixPack('PUT /v1/workspaces/:workspaceId/health-settings', {
  t: () => t,
  write: true,
  prepare: async (owner) => ({
    method: 'PUT',
    url: `${ws(owner.workspaceId)}/health-settings`,
    payload: { cashAccountIds: null, targetMonths: 3, countInvestments: true },
    badPayload: { cashAccountIds: null, targetMonths: 5, countInvestments: true },
    assert: (res) => {
      expect(res.json().targetMonths).toBe(3);
    },
  }),
});

sixPack('GET /v1/workspaces/:workspaceId/reports/dashboards', {
  t: () => t,
  write: false,
  prepare: async (owner) => ({
    method: 'GET',
    url: `${ws(owner.workspaceId)}/reports/dashboards`,
    assert: (res) => {
      expect(res.json().dashboards.map((d: { name: string }) => d.name)).toEqual(['Overview', 'Year in review']);
    },
  }),
});

sixPack('POST /v1/workspaces/:workspaceId/reports/saved', {
  t: () => t,
  write: true,
  prepare: async (owner) => ({
    method: 'POST',
    url: `${ws(owner.workspaceId)}/reports/saved`,
    status: 201,
    payload: { name: 'Eating out', spec: { show: 'spending', groupBy: 'payee' } },
    badPayload: { name: 'Eating out', spec: { show: 'profit', groupBy: 'payee' } },
    assert: (res) => {
      expect(res.json()).toMatchObject({ name: 'Eating out', spec: { splitBy: null, chart: 'bar', filters: {} } });
    },
  }),
});
