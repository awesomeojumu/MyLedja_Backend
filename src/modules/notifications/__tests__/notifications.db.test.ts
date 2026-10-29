import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newWorkspace, startTestApp, type TestApp } from '../../../../test/helpers/test-app.js';

let t: TestApp;
beforeAll(async () => {
  t = await startTestApp();
});
afterAll(() => t.close());

describe('notifications (B2.8)', () => {
  it('lists, dedupes createOnce, marks read and dismisses', async () => {
    const w = await newWorkspace(t);
    const uid = w.ctx.userId!;
    const n1 = await t.services.notifications.createOnce(w.ctx, {
      userId: uid,
      kind: 'budget',
      title: 'Transport is at 92% of plan',
      body: 'See budget',
      dedupeKey: 'budget:transport:2026-10',
    });
    const n2 = await t.services.notifications.createOnce(w.ctx, {
      userId: uid,
      kind: 'budget',
      title: 'Transport is at 92% of plan',
      body: 'See budget',
      dedupeKey: 'budget:transport:2026-10',
    });
    expect(n2._id).toBe(n1._id);
    const page = await t.services.notifications.list(w.ctx, { limit: 20 });
    expect(page.unreadCount).toBe(1);
    const read = await t.services.notifications.markRead(w.ctx, n1._id);
    expect(read.readAt).toBeTruthy();
    const sec = await t.services.notifications.createOnce(w.ctx, {
      userId: uid,
      kind: 'security',
      title: 'New sign-in on Chrome, Lagos',
      body: 'Was this you?',
      security: true,
      dedupeKey: 'security:sign-in:1',
    });
    await expect(t.services.notifications.dismiss(w.ctx, sec._id)).rejects.toMatchObject({ code: 'security_notice' });
    const all = await t.services.notifications.markAllRead(w.ctx);
    expect(all.updated).toBeGreaterThanOrEqual(0);
  });

  it('creates a sync notice once per dedupe key', async () => {
    const w = await newWorkspace(t);
    const uid = w.ctx.userId!;
    await t.services.notifications.createOnce(w.ctx, {
      userId: uid,
      kind: 'sync',
      title: '3 waiting to sync',
      body: 'Changes will send when you are back online.',
      dedupeKey: 'sync:waiting:3',
    });
    await t.services.notifications.createOnce(w.ctx, {
      userId: uid,
      kind: 'sync',
      title: '3 waiting to sync',
      body: 'Changes will send when you are back online.',
      dedupeKey: 'sync:waiting:3',
    });
    const page = await t.services.notifications.list(w.ctx, { kind: 'sync', limit: 10 });
    expect(page.items).toHaveLength(1);
  });

  it('puts notification docs on the sync change feed (server→FE)', async () => {
    const w = await newWorkspace(t);
    const before = await t.services.sync.pull(w.ctx, { since: '0', limit: 500 });
    const n = await t.services.notifications.createOnce(w.ctx, {
      userId: w.ctx.userId!,
      kind: 'security',
      title: 'New sign-in on another device',
      body: 'Was this you?',
      security: true,
      dedupeKey: `security:feed:${Date.now()}`,
      actions: [{ key: 'security_review', label: 'Review', target: { path: '/settings/security' } }],
    });
    const after = await t.services.sync.pull(w.ctx, { since: before.nextSince, limit: 500 });
    const change = after.changes.find((c) => c.collection === 'notifications' && c.id === n._id);
    expect(change).toMatchObject({ op: 'upsert' });
    expect(change!.doc).toMatchObject({
      id: n._id,
      kind: 'security',
      security: true,
      title: 'New sign-in on another device',
    });
  });
});
