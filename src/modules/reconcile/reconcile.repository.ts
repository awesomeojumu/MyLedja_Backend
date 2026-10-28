import type { ClientSession, Db } from 'mongodb';
import { BaseRepository } from '../../common/repository/base.repository.js';
import type { WorkspaceContext } from '../../common/workspace/workspace-context.js';

type Opts = { session?: ClientSession };

export type ReconciliationDoc = {
  _id: string;
  workspaceId: string;
  accountId: string;
  status: 'in_progress' | 'finished' | 'cancelled';
  statementDate: string;
  /** Statement balance as shown (kobo string stored as the person's figure). */
  statementBalanceMinor: string;
  tickedIds: string[];
  adjustmentId: string | null;
  finishedAt: Date | null;
  finishedBy: string | null;
  unlocked: { transactionId: string; at: string; by: string | null }[];
  createdAt: Date;
  updatedAt: Date;
  version: number;
};

export class ReconciliationsRepository extends BaseRepository<ReconciliationDoc> {
  constructor(db: Db) {
    super(db, 'reconciliations');
  }

  byId(ctx: WorkspaceContext, id: string, o: Opts = {}) {
    return this.findOne(ctx, { _id: id }, o);
  }

  inProgress(ctx: WorkspaceContext, accountId: string, o: Opts = {}) {
    return this.findOne(ctx, { accountId, status: 'in_progress' }, o);
  }

  forAccount(ctx: WorkspaceContext, accountId: string, o: Opts = {}) {
    return this.find(ctx, { accountId }, { ...o, sort: { createdAt: -1 } });
  }
}
