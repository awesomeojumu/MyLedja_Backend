import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, op, signUp, startTestApp, type TestApp, twoWorkspaces } from '../../../../test/helpers/test-app.js';

let t: TestApp;
beforeAll(async () => {
  t = await startTestApp();
});
afterAll(() => t.close());

const setupBody = {
  workspaceName: 'Home money',
  currency: 'NGN',
  weekStart: 'monday',
  accounts: [
    { name: 'GTBank Current', type: 'bank', openingBalance: '81230000', openingDate: '2026-10-01' },
    { name: 'Bank loan', type: 'loan', openingBalance: '84000000', openingDate: '2026-10-01' },
  ],
  categories: [
    { key: 'rent', group: 'Home', name: 'Rent' },
    { key: 'tithe', group: 'Faith', name: 'Tithe' },
  ],
  budgetStyle: 'envelope',
  monthlyTakeHome: '64000000',
  skippedSteps: [4, 4],
};

const setup = (workspaceId: string, auth: Record<string, string>, body: unknown = setupBody, headers = op()) =>
  t.app.inject({
    method: 'POST',
    url: `/v1/workspaces/${workspaceId}/setup`,
    headers: { ...headers, ...auth },
    payload: body as object,
  });

describe('GET /v1/workspaces/:workspaceId', () => {
  it('works', async () => {
    const ada = await signUp(t);
    const res = await t.app.inject({ method: 'GET', url: `/v1/workspaces/${ada.workspaceId}`, headers: ada.auth });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      id: ada.workspaceId,
      name: 'Personal',
      type: 'personal',
      currency: 'NGN',
      timeZone: 'Africa/Lagos',
      weekStart: 'monday',
      budgetStyle: 'tracking',
      setupComplete: false,
      skippedSteps: [],
      role: 'owner',
      features: [],
      version: 1,
    });
  });

  it('checks input: a malformed id is not found', async () => {
    const ada = await signUp(t);
    expect(
      (await t.app.inject({ method: 'GET', url: '/v1/workspaces/not-a-uuid', headers: ada.auth })).statusCode,
    ).toBe(404);
  });

  it('needs sign-in', async () => {
    const ada = await signUp(t);
    expect((await t.app.inject({ method: 'GET', url: `/v1/workspaces/${ada.workspaceId}` })).statusCode).toBe(401);
  });

  it("stays in its workspace: B gets 404 for A's workspace (E-13)", async () => {
    const { a, b } = await twoWorkspaces(t);
    const res = await t.app.inject({ method: 'GET', url: `/v1/workspaces/${a.workspaceId}`, headers: b.auth });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('not_found');
  });
});

describe('POST /v1/workspaces/:workspaceId/setup (Welcome, P04)', () => {
  it('works: saves the choices, keeps the accounts and categories for the ledger, and writes an audit entry', async () => {
    const ada = await signUp(t);
    const res = await setup(ada.workspaceId, ada.auth);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      setupComplete: true,
      workspaceName: 'Home money',
      workspaceId: ada.workspaceId,
    });
    const ws = await t.db.collection('workspaces').findOne({ _id: ada.workspaceId as never });
    expect(ws).toMatchObject({
      name: 'Home money',
      budgetStyle: 'envelope',
      setupComplete: true,
      skippedSteps: [4],
      version: 2,
    });
    expect(ws?.setupDraft.accounts[0].openingBalance).toBe(81230000n);
    expect(ws?.setupDraft.monthlyTakeHome).toBe(64000000n);
    const audit = await t.db
      .collection('audit_events')
      .findOne({ workspaceId: ada.workspaceId, action: 'workspace.setup_finished' });
    expect(audit).toMatchObject({
      userId: ada.userId,
      before: { name: 'Personal', setupComplete: false },
      after: { name: 'Home money', setupComplete: true, accounts: 2, categories: 2 },
    });
    expect(audit?.sessionId).toEqual(expect.any(String));
  });

  it('checks input with DESIGN.md messages', async () => {
    const ada = await signUp(t);
    const bad = await setup(ada.workspaceId, ada.auth, { ...setupBody, workspaceName: ' ' });
    expect(bad.json()).toEqual({ code: 'invalid_input', field: 'workspaceName', message: 'Add a name' });
    const amount = await setup(ada.workspaceId, ada.auth, {
      ...setupBody,
      accounts: [{ ...setupBody.accounts[0], openingBalance: '812300.00' }],
    });
    expect(amount.json()).toEqual({
      code: 'invalid_input',
      field: 'accounts.0.openingBalance',
      message: 'Enter an amount in naira, for example 25000',
    });
    const date = await setup(ada.workspaceId, ada.auth, {
      ...setupBody,
      accounts: [{ ...setupBody.accounts[0], openingDate: '2026-02-30' }],
    });
    expect(date.json()).toMatchObject({ field: 'accounts.0.openingDate', message: 'Choose a date' });
  });

  it('needs sign-in', async () => {
    const ada = await signUp(t);
    expect((await setup(ada.workspaceId, {})).statusCode).toBe(401);
  });

  it("stays in its workspace: B can't set up A's workspace, and nothing in A changes", async () => {
    const { a, b } = await twoWorkspaces(t);
    const before = await t.db.collection('workspaces').findOne({ _id: a.workspaceId as never });
    const res = await setup(a.workspaceId, b.auth);
    expect(res.statusCode).toBe(404);
    expect(await t.db.collection('workspaces').findOne({ _id: a.workspaceId as never })).toEqual(before);
  });

  it('respects roles: a Viewer or Editor gets 403; an Admin may', async () => {
    const { a, b } = await twoWorkspaces(t);
    await addMember(t, a.workspaceId, b.userId, 'viewer');
    const read = await t.app.inject({ method: 'GET', url: `/v1/workspaces/${a.workspaceId}`, headers: b.auth });
    expect(read.json().role).toBe('viewer');
    const viewer = await setup(a.workspaceId, b.auth);
    expect(viewer.statusCode).toBe(403);
    expect(viewer.json()).toEqual({ code: 'forbidden', message: "Your role in this workspace doesn't allow this." });
    await t.db
      .collection('memberships')
      .updateOne({ workspaceId: a.workspaceId, userId: b.userId }, { $set: { role: 'editor' } });
    expect((await setup(a.workspaceId, b.auth)).statusCode).toBe(403);
    await t.db
      .collection('memberships')
      .updateOne({ workspaceId: a.workspaceId, userId: b.userId }, { $set: { role: 'admin' } });
    expect((await setup(a.workspaceId, b.auth)).statusCode).toBe(200);
  });

  it('runs once: the same operationId changes the workspace once', async () => {
    const ada = await signUp(t);
    const headers = op();
    const first = await setup(ada.workspaceId, ada.auth, setupBody, headers);
    const second = await setup(ada.workspaceId, ada.auth, setupBody, headers);
    expect(second.json()).toEqual(first.json());
    const ws = await t.db.collection('workspaces').findOne({ _id: ada.workspaceId as never });
    expect(ws?.version).toBe(2);
    expect(
      await t.db
        .collection('audit_events')
        .countDocuments({ workspaceId: ada.workspaceId, action: 'workspace.setup_finished' }),
    ).toBe(1);
  });

  it("an operationId is per person: B reusing A's id still runs", async () => {
    const { a, b } = await twoWorkspaces(t);
    const headers = op();
    expect((await setup(a.workspaceId, a.auth, setupBody, headers)).statusCode).toBe(200);
    expect((await setup(b.workspaceId, b.auth, setupBody, headers)).statusCode).toBe(200);
  });

  it('lands on the Dashboard after setup (P01-01)', async () => {
    const ada = await signUp(t);
    await setup(ada.workspaceId, ada.auth);
    const res = await t.app.inject({
      method: 'POST',
      url: '/v1/auth/sign-in',
      headers: op(),
      payload: { email: ada.email, password: ada.password },
    });
    expect(res.json().user).toMatchObject({ setupComplete: true, workspaceName: 'Home money' });
  });
});
