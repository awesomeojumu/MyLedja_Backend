import { afterAll, beforeAll, expect } from 'vitest';
import { moneyWorld, sixPack } from '../../../../test/helpers/six-pack.js';
import { startTestApp, type TestApp } from '../../../../test/helpers/test-app.js';

let t: TestApp;
beforeAll(async () => {
  t = await startTestApp();
});
afterAll(() => t.close());

sixPack('GET /v1/workspaces/:workspaceId/dashboard', {
  t: () => t,
  write: false,
  prepare: async (owner) => {
    await moneyWorld(t, owner);
    return {
      method: 'GET',
      url: `/v1/workspaces/${owner.workspaceId}/dashboard?month=2026-10`,
      badUrl: `/v1/workspaces/${owner.workspaceId}/dashboard?month=2026-13`,
      assert: (res) => {
        expect(res.json()).toMatchObject({
          month: '2026-10',
          tiles: expect.objectContaining({
            income: expect.any(Object),
            spent: expect.any(Object),
          }),
        });
      },
    };
  },
});
