import type { ClientSession, Db } from 'mongodb';
import { BaseRepository } from '../../common/repository/base.repository.js';
import type { WorkspaceContext } from '../../common/workspace/workspace-context.js';
import type { z } from 'zod';
import type { RecurrenceRule } from '../schedules/schedules.contract.js';

type Opts = { session?: ClientSession };

export type GoalDoc = {
  _id: string;
  workspaceId: string;
  name: string;
  icon: string | null;
  targetAmountMinor: string;
  targetDate: string | null;
  accountId: string;
  categoryId: string | null;
  savedAmountMinor: string;
  status: 'in_progress' | 'paused' | 'completed';
  notes: string | null;
  schedule: { amountMinor: string; recurrence: z.output<typeof RecurrenceRule>; startDate: string } | null;
  completedAt: Date | null;
  operationId: string | null;
  createdAt: Date;
  updatedAt: Date;
  version: number;
};

export type GoalAllocationDoc = {
  _id: string;
  workspaceId: string;
  goalId: string;
  date: string;
  amountMinor: string;
  fromAccountId: string | null;
  transactionId: string | null;
  createdAt: Date;
  updatedAt: Date;
  version: number;
};

export class GoalsRepository extends BaseRepository<GoalDoc> {
  constructor(db: Db) {
    super(db, 'goals');
  }
}

export class GoalAllocationsRepository extends BaseRepository<GoalAllocationDoc> {
  constructor(db: Db) {
    super(db, 'goal_allocations');
  }

  sumForGoal(ctx: WorkspaceContext, goalId: string, o: Opts = {}) {
    return this.find(ctx, { goalId }, o);
  }
}
