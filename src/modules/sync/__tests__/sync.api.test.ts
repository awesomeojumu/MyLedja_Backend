import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, expect } from 'vitest';
import { moneyWorld, sixPack } from '../../../../test/helpers/six-pack.js';
import { startTestApp, type TestApp } from '../../../../test/helpers/test-app.js';
import { CURRENT_SCHEMA_VERSION } from '../sync.contract.js';

let t: TestApp;
beforeAll(async () => {
  t = await startTestApp();
});
afterAll(() => t.close());

sixPack('POST /v1/workspaces/:workspaceId/sync/operations', {
  t: () => t,
  write: true,
  prepare: async (owner) => {
    const w = await moneyWorld(t, owner);
    const operationId = uuidv7();
    return {
      method: 'POST',
      url: `${w.base}/sync/operations`,
      payload: {
        deviceId: 'phone-test',
        operations: [
          {
            operationId,
            type: 'transaction.create',
            targetId: null,
            payload: {
              type: 'expense',
              accountId: w.account.id,
              categoryId: w.fees.id,
              amount: '150000',
              date: '2026-10-05',
            },
            baseVersion: null,
            createdAt: new Date().toISOString(),
            schemaVersion: CURRENT_SCHEMA_VERSION,
          },
        ],
      },
      badPayload: { deviceId: 'phone-test', operations: [] },
      assert: (res) => {
        expect(res.json().results).toHaveLength(1);
        expect(res.json().results[0]).toMatchObject({
          operationId,
          status: expect.stringMatching(/^(applied|duplicate)$/),
        });
      },
    };
  },
});

sixPack('GET /v1/workspaces/:workspaceId/sync/changes', {
  t: () => t,
  write: false,
  prepare: async (owner) => {
    await moneyWorld(t, owner);
    return {
      method: 'GET',
      url: `/v1/workspaces/${owner.workspaceId}/sync/changes?since=0`,
      badUrl: `/v1/workspaces/${owner.workspaceId}/sync/changes?since=abc`,
      assert: (res) => {
        expect(res.json()).toMatchObject({
          changes: expect.any(Array),
          nextSince: expect.any(String),
          hasMore: expect.any(Boolean),
          reset: expect.any(Boolean),
        });
      },
    };
  },
});
