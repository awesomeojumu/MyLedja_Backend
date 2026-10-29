import type { ClientSession } from 'mongodb';
import type { z } from 'zod';
import { AppError, Errors } from '../../common/errors/errors.js';
import { newId } from '../../common/ids/ids.js';
import type { WorkspaceContext } from '../../common/workspace/workspace-context.js';
import type { Database } from '../../db/client.js';
import type { LedgerService } from '../ledger/ledger.service.js';
import type { Notification, NotificationPage, NOTIFICATION_KINDS } from './notifications.contract.js';
import { type NotificationDoc, NotificationsRepository } from './notifications.repository.js';

type CreateInput = {
  userId: string;
  kind: (typeof NOTIFICATION_KINDS)[number];
  title: string;
  body: string;
  amountMinor?: string | null;
  hideAmount?: boolean;
  security?: boolean;
  actions?: NotificationDoc['actions'];
  dedupeKey?: string | null;
};

const encodeCursor = (createdAt: Date, id: string) =>
  Buffer.from(`${createdAt.toISOString()}\t${id}`).toString('base64url');
const decodeCursor = (cursor: string) => {
  const [at, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('\t');
  if (!at || !id) throw Errors.validation('cursor', 'This list has moved. Refresh and try again.');
  return { createdAt: new Date(at), id };
};

/** In-app inbox (B2.8). Other modules create rows through `createOnce`. */
export class NotificationsService {
  constructor(
    private readonly database: Database,
    private readonly repo: NotificationsRepository,
    private readonly ledger: LedgerService,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private userId(ctx: WorkspaceContext): string {
    if (!ctx.userId) throw Errors.unauthorized();
    return ctx.userId;
  }

  async list(
    ctx: WorkspaceContext,
    q: { kind?: (typeof NOTIFICATION_KINDS)[number]; cursor?: string; limit: number },
  ): Promise<z.input<typeof NotificationPage>> {
    const uid = this.userId(ctx);
    const filter: Record<string, unknown> = { userId: uid, dismissedAt: null };
    if (q.kind) filter.kind = q.kind;
    if (q.cursor) {
      const c = decodeCursor(q.cursor);
      filter.$or = [{ createdAt: { $lt: c.createdAt } }, { createdAt: c.createdAt, _id: { $lt: c.id } }];
    }
    const docs = await this.repo.find(ctx, filter as never, { sort: { createdAt: -1, _id: -1 }, limit: q.limit + 1 });
    const page = docs.slice(0, q.limit);
    const unread = await this.repo.count(ctx, { userId: uid, dismissedAt: null, readAt: null } as never);
    return {
      items: page.map((d) => this.view(d)),
      nextCursor: docs.length > q.limit ? encodeCursor(page.at(-1)!.createdAt, page.at(-1)!._id) : null,
      unreadCount: unread,
    };
  }

  async markRead(ctx: WorkspaceContext, id: string): Promise<z.input<typeof Notification>> {
    return this.database.transaction(async (session) => {
      const doc = await this.repo.byId(ctx, this.userId(ctx), id, { session });
      if (!doc) throw Errors.notFound();
      if (doc.readAt) return this.view(doc);
      const now = this.now();
      const after = await this.repo.findOneAndUpdate(
        ctx,
        { _id: id, userId: this.userId(ctx), version: doc.version },
        { $set: { readAt: now, updatedAt: now }, $inc: { version: 1 } },
        { session },
      );
      if (!after) throw Errors.notFound();
      await this.ledger.feed(ctx, [{ collection: 'notifications', docId: id, op: 'upsert' }], session);
      return this.view(after);
    });
  }

  async markAllRead(ctx: WorkspaceContext): Promise<{ updated: number }> {
    const now = this.now();
    const result = await this.database.transaction(async (session) => {
      const uid = this.userId(ctx);
      const unread = await this.repo.find(ctx, { userId: uid, dismissedAt: null, readAt: null } as never, {
        session,
        projection: { _id: 1 },
      });
      if (unread.length === 0) return 0;
      await this.repo.updateMany(
        ctx,
        { userId: uid, dismissedAt: null, readAt: null } as never,
        { $set: { readAt: now, updatedAt: now }, $inc: { version: 1 } } as never,
        { session },
      );
      await this.ledger.feed(
        ctx,
        unread.map((n) => ({ collection: 'notifications', docId: n._id, op: 'upsert' as const })),
        session,
      );
      return unread.length;
    });
    return { updated: result };
  }

  async dismiss(ctx: WorkspaceContext, id: string): Promise<z.input<typeof Notification>> {
    return this.database.transaction(async (session) => {
      const doc = await this.repo.byId(ctx, this.userId(ctx), id, { session });
      if (!doc) throw Errors.notFound();
      if (doc.security) throw new AppError(403, 'security_notice', 'Answer this notice before you dismiss it.');
      const now = this.now();
      const after = await this.repo.findOneAndUpdate(
        ctx,
        { _id: id, userId: this.userId(ctx), version: doc.version },
        { $set: { dismissedAt: now, updatedAt: now }, $inc: { version: 1 } },
        { session },
      );
      if (!after) throw Errors.notFound();
      await this.ledger.feed(ctx, [{ collection: 'notifications', docId: id, op: 'upsert' }], session);
      return this.view(after);
    });
  }

  /** Creates a notification once per dedupeKey (B2.8: each type created once). */
  async createOnce(ctx: WorkspaceContext, input: CreateInput, session?: ClientSession) {
    const { doc } = await this.createOnceDetailed(ctx, input, session);
    return doc;
  }

  /** Same as `createOnce`, plus whether this call inserted a new row (for email/push side-effects). */
  async createOnceDetailed(
    ctx: WorkspaceContext,
    input: CreateInput,
    session?: ClientSession,
  ): Promise<{ doc: NotificationDoc; created: boolean }> {
    const run = async (s: ClientSession) => {
      if (input.dedupeKey) {
        const same = await this.repo.byDedupe(ctx, input.userId, input.dedupeKey, { session: s });
        if (same) return { doc: same, created: false };
      }
      const now = this.now();
      const doc = await this.repo.insertOne(
        ctx,
        {
          _id: newId(),
          userId: input.userId,
          kind: input.kind,
          title: input.title,
          body: input.body,
          amountMinor: input.hideAmount ? null : (input.amountMinor ?? null),
          readAt: null,
          dismissedAt: null,
          security: input.security ?? false,
          actions: input.actions ?? [],
          dedupeKey: input.dedupeKey ?? null,
          createdAt: now,
          updatedAt: now,
          version: 1,
        },
        { session: s },
      );
      await this.ledger.feed(ctx, [{ collection: 'notifications', docId: doc._id, op: 'upsert' }], s);
      return { doc, created: true };
    };
    if (session) return run(session);
    return this.database.transaction(run);
  }

  async serialize(ctx: WorkspaceContext, id: string): Promise<z.input<typeof Notification>> {
    const doc = await this.repo.findOne(ctx, { _id: id, userId: this.userId(ctx) });
    if (!doc) throw Errors.notFound();
    return this.view(doc);
  }

  private view(doc: NotificationDoc): z.input<typeof Notification> {
    return {
      id: doc._id,
      kind: doc.kind,
      title: doc.title,
      body: doc.body,
      amount: doc.amountMinor,
      readAt: doc.readAt?.toISOString() ?? null,
      dismissedAt: doc.dismissedAt?.toISOString() ?? null,
      security: doc.security,
      actions: doc.actions,
      createdAt: doc.createdAt.toISOString(),
      version: doc.version,
    };
  }
}
