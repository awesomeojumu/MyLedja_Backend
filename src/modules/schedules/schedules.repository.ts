import type { ClientSession, Db } from 'mongodb';
import { BaseRepository } from '../../common/repository/base.repository.js';
import type { WorkspaceContext } from '../../common/workspace/workspace-context.js';
import type { z } from 'zod';
import type { RecurrenceRule, ReminderRule, ScheduleEnd } from './schedules.contract.js';

type Opts = { session?: ClientSession };

export type ScheduleDoc = {
  _id: string;
  workspaceId: string;
  kind: 'bill' | 'subscription' | 'transfer' | 'income';
  name: string;
  payeeId: string | null;
  accountId: string | null;
  categoryId: string | null;
  toAccountId: string | null;
  amountMinor: string;
  amountApproximate: boolean;
  recurrence: z.output<typeof RecurrenceRule>;
  startDate: string;
  end: z.output<typeof ScheduleEnd>;
  autoPost: boolean;
  reminder: z.output<typeof ReminderRule> | null;
  nextDate: string | null;
  status: 'active' | 'paused' | 'cancelled';
  cancelledAt: Date | null;
  operationId: string | null;
  createdAt: Date;
  updatedAt: Date;
  version: number;
};

export type OccurrenceDoc = {
  _id: string;
  workspaceId: string;
  scheduleId: string;
  date: string;
  amountMinor: string;
  status: 'scheduled' | 'due' | 'overdue' | 'paid' | 'received' | 'missed' | 'skipped';
  matchedTransactionId: string | null;
  paidAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  version: number;
};

export class SchedulesRepository extends BaseRepository<ScheduleDoc> {
  constructor(db: Db) {
    super(db, 'schedules');
  }

  page(
    ctx: WorkspaceContext,
    filter: Record<string, unknown>,
    cursor: string | undefined,
    limit: number,
    o: Opts = {},
  ) {
    const q = { ...filter, ...(cursor ? { _id: { $gt: cursor } } : {}) };
    return this.find(ctx, q as never, { ...o, sort: { _id: 1 }, limit: limit + 1 });
  }
}

export class OccurrencesRepository extends BaseRepository<OccurrenceDoc> {
  constructor(db: Db) {
    super(db, 'occurrences');
  }

  forMonth(ctx: WorkspaceContext, month: string, scheduleId?: string, o: Opts = {}) {
    const filter: Record<string, unknown> = {
      date: { $gte: `${month}-01`, $lte: `${month}-31` },
    };
    if (scheduleId) filter.scheduleId = scheduleId;
    return this.find(ctx, filter as never, { ...o, sort: { date: 1, _id: 1 } });
  }

  byScheduleDate(ctx: WorkspaceContext, scheduleId: string, date: string, o: Opts = {}) {
    return this.findOne(ctx, { scheduleId, date }, o);
  }
}
