import { MongoServerError } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../common/ids/ids.js';
import { memberContext, systemContext } from '../../common/workspace/workspace-context.js';
import { AuditRepository } from '../../modules/audit/audit.repository.js';
import { WorkspacesRepository } from '../../modules/workspaces/workspaces.repository.js';
import { startTestApp, type TestApp } from '../../../test/helpers/test-app.js';
import { MIGRATIONS, migrate } from '../migrations/index.js';

let t: TestApp;
beforeAll(async () => {
  t = await startTestApp();
});
afterAll(() => t.close());

describe('migrations (B0.3)', () => {
  it('run twice without error, and the second run applies nothing', async () => {
    const fresh = t.database.client.db(`${t.db.databaseName}_m`);
    expect(await migrate(fresh)).toEqual(MIGRATIONS.map((m) => m.name));
    expect(await migrate(fresh)).toEqual([]);
    await MIGRATIONS[0]!.up(fresh);
    await fresh.dropDatabase();
  });
});

describe('validators (B0.3, TECH-SPEC 5.4)', () => {
  it('refuse a document that breaks the schema', async () => {
    const bad = { _id: 'not-a-uuid', email: 'a@b.test' };
    await expect(t.db.collection('users').insertOne(bad as never)).rejects.toBeInstanceOf(MongoServerError);
    const now = new Date();
    const badRole = {
      _id: newId(),
      workspaceId: newId(),
      userId: newId(),
      role: 'superuser',
      createdAt: now,
      updatedAt: now,
      version: 1,
    };
    await expect(t.db.collection('memberships').insertOne(badRole as never)).rejects.toMatchObject({ code: 121 });
  });
});

describe('BaseRepository (B0.4)', () => {
  const ws = (id: string) => ({
    _id: id,
    name: `ws ${id.slice(-4)}`,
    type: 'personal' as const,
    currency: 'NGN',
    timeZone: 'Africa/Lagos',
    weekStart: 'monday' as const,
    budgetStyle: 'tracking' as const,
    setupComplete: false,
    skippedSteps: [],
    features: [],
    ownerId: newId(),
    setupDraft: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    version: 1,
  });

  it("never returns or changes another workspace's documents", async () => {
    const repo = new WorkspacesRepository(t.db);
    const a = systemContext(newId());
    const b = systemContext(newId());
    await repo.insertOne(a, ws(a.workspaceId));
    await repo.insertOne(b, ws(b.workspaceId));

    expect(await repo.findOne(b, { _id: a.workspaceId })).toBeNull();
    expect((await repo.find(b, {})).map((d) => d._id)).toEqual([b.workspaceId]);
    expect(await repo.count(b, { _id: a.workspaceId })).toBe(0);
    expect((await repo.updateOne(b, { _id: a.workspaceId }, { $set: { name: 'hacked' } })).matchedCount).toBe(0);
    expect(await repo.findOneAndUpdate(b, { _id: a.workspaceId }, { $set: { name: 'hacked' } })).toBeNull();
    expect((await repo.deleteOne(b, { _id: a.workspaceId })).deletedCount).toBe(0);
    expect((await repo.get(a))?.name).not.toBe('hacked');
  });

  it("ignores a filter or update that tries to name another workspace's id", async () => {
    const repo = new AuditRepository(t.db);
    const a = memberContext({ workspaceId: newId(), userId: newId(), sessionId: null, role: 'owner' });
    const b = memberContext({ workspaceId: newId(), userId: newId(), sessionId: null, role: 'owner' });
    const entry = await repo.record(a, { action: 'test.a' });
    expect(await repo.find(b, { workspaceId: a.workspaceId } as never)).toEqual([]);
    await repo.updateOne(a, { _id: entry._id }, { $set: { workspaceId: b.workspaceId, action: 'moved' } as never });
    expect(await repo.findOne(a, { _id: entry._id })).toMatchObject({ workspaceId: a.workspaceId, action: 'moved' });
    const inserted = await repo.insertOne(a, { ...entry, _id: newId(), workspaceId: b.workspaceId } as never);
    expect(inserted.workspaceId).toBe(a.workspaceId);
  });

  it('refuses a call without a context, at compile time and at run time', async () => {
    const repo = new AuditRepository(t.db);
    // @ts-expect-error a WorkspaceContext is required
    await expect(repo.find(undefined, {})).rejects.toThrow('workspace_context_missing');
    // @ts-expect-error a plain object isn't a WorkspaceContext
    await expect(repo.list({ workspaceId: '' })).rejects.toThrow('workspace_context_missing');
  });
});
