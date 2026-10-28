import type { ClientSession, Db } from 'mongodb';
import { BaseRepository } from '../../common/repository/base.repository.js';
import type { WorkspaceContext } from '../../common/workspace/workspace-context.js';
import type { NOTIFICATION_KINDS } from './notifications.contract.js';

type Opts = { session?: ClientSession };

export type NotificationDoc = {
  _id: string;
  workspaceId: string;
  userId: string;
  kind: (typeof NOTIFICATION_KINDS)[number];
  title: string;
  body: string;
  amountMinor: string | null;
  readAt: Date | null;
  dismissedAt: Date | null;
  security: boolean;
  actions: { key: string; label: string; target: { path: string; params?: Record<string, string> } | null }[];
  dedupeKey: string | null;
  createdAt: Date;
  updatedAt: Date;
  version: number;
};

export class NotificationsRepository extends BaseRepository<NotificationDoc> {
  constructor(db: Db) {
    super(db, 'notifications');
  }

  byId(ctx: WorkspaceContext, userId: string, id: string, o: Opts = {}) {
    return this.findOne(ctx, { _id: id, userId }, o);
  }

  byDedupe(ctx: WorkspaceContext, userId: string, dedupeKey: string, o: Opts = {}) {
    return this.findOne(ctx, { userId, dedupeKey, dismissedAt: null }, o);
  }
}
