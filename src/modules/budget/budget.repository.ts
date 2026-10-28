import type { ClientSession, Db } from 'mongodb';
import { BaseRepository } from '../../common/repository/base.repository.js';
import type { WorkspaceContext } from '../../common/workspace/workspace-context.js';

type Opts = { session?: ClientSession };

export type BudgetMonthDoc = {
  _id: string;
  workspaceId: string;
  month: string;
  categoryId: string;
  assignedMinor: bigint;
  updatedAt: Date;
  version: number;
};

/** Assigned plan (or limit) per spending category per month (TECH-SPEC 5.4 `budget_months`). */
export class BudgetMonthsRepository extends BaseRepository<BudgetMonthDoc> {
  constructor(db: Db) {
    super(db, 'budget_months');
  }

  forMonths(ctx: WorkspaceContext, from: string, to: string, o: Opts = {}) {
    return this.find(ctx, { month: { $gte: from, $lte: to } }, o);
  }

  forMonth(ctx: WorkspaceContext, month: string, o: Opts = {}) {
    return this.find(ctx, { month }, o);
  }

  byCategoryMonth(ctx: WorkspaceContext, categoryId: string, month: string, o: Opts = {}) {
    return this.findOne(ctx, { categoryId, month }, o);
  }

  async earliest(ctx: WorkspaceContext, o: Opts = {}) {
    const [first] = await this.find(ctx, {}, { ...o, sort: { month: 1 }, limit: 1 });
    return first ?? null;
  }

  /** Sets the assigned amount for a category in a month, creating the row if needed. */
  async setAssigned(
    ctx: WorkspaceContext,
    month: string,
    categoryId: string,
    assignedMinor: bigint,
    now: Date,
    o: Opts = {},
  ): Promise<BudgetMonthDoc> {
    const after = await this.findOneAndUpdate(
      ctx,
      { _id: `${categoryId}:${month}` },
      {
        $set: { assignedMinor, updatedAt: now },
        $inc: { version: 1 },
        $setOnInsert: { month, categoryId },
      },
      { ...o, upsert: true },
    );
    return after!;
  }
}
