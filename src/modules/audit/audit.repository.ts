import type { ClientSession, Db, Document } from 'mongodb';
import { newId } from '../../common/ids/ids.js';
import { BaseRepository } from '../../common/repository/base.repository.js';
import type { WorkspaceContext } from '../../common/workspace/workspace-context.js';

export type AuditDoc = {
  _id: string;
  workspaceId: string;
  at: Date;
  userId: string | null;
  sessionId: string | null;
  action: string;
  target: { collection: string; id: string } | null;
  before?: Document;
  after?: Document;
};

/** The activity log: who, which device, what, when (TECH-SPEC 5.5). Written in the same transaction as the change. */
export class AuditRepository extends BaseRepository<AuditDoc> {
  constructor(db: Db) {
    super(db, 'audit_events');
  }

  record(
    ctx: WorkspaceContext,
    entry: {
      action: string;
      target?: AuditDoc['target'];
      before?: Document;
      after?: Document;
      sessionId?: string | null;
    },
    o: { session?: ClientSession } = {},
  ) {
    return this.insertOne(
      ctx,
      {
        _id: newId(),
        at: new Date(),
        userId: ctx.userId,
        sessionId: entry.sessionId ?? ctx.sessionId,
        action: entry.action,
        target: entry.target ?? null,
        ...(entry.before ? { before: entry.before } : {}),
        ...(entry.after ? { after: entry.after } : {}),
      },
      o,
    );
  }

  list(ctx: WorkspaceContext, limit = 50) {
    return this.find(ctx, {}, { sort: { at: -1 }, limit });
  }
}
