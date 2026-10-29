import type { z } from 'zod';
import { AppError, Errors } from '../../common/errors/errors.js';
import { newId } from '../../common/ids/ids.js';
import { parseMinor, toMinorString } from '../../common/money/money.js';
import type { WorkspaceContext } from '../../common/workspace/workspace-context.js';
import type { Database } from '../../db/client.js';
import type { AuditRepository } from '../audit/audit.repository.js';
import type { LedgerService } from '../ledger/ledger.service.js';
import { goalRoutes as goalRouteDefs } from './goals.contract.js';
import type { Allocation, Goal } from './goals.contract.js';
import {
  type GoalAllocationDoc,
  GoalAllocationsRepository,
  type GoalDoc,
  GoalsRepository,
} from './goals.repository.js';

type CreateBody = z.output<NonNullable<(typeof goalRouteDefs)['create']['body']>>;
type UpdateBody = z.output<NonNullable<(typeof goalRouteDefs)['update']['body']>>;
type AllocateBody = z.output<NonNullable<(typeof goalRouteDefs)['allocate']['body']>>;

const GoalErrors = {
  stale: (current: z.input<typeof Goal>) =>
    new AppError(409, 'already_changed', 'This was already changed on another device.', { current }),
};

function monthsBetween(from: string, to: string): number {
  const a = from.slice(0, 7);
  const b = to.slice(0, 7);
  const [y1, m1] = a.split('-').map(Number);
  const [y2, m2] = b.split('-').map(Number);
  return (y2! - y1!) * 12 + (m2! - m1!) + 1;
}

const toGoal = (d: GoalDoc): z.input<typeof Goal> => {
  const saved = parseMinor(d.savedAmountMinor);
  const target = parseMinor(d.targetAmountMinor);
  let neededPerMonth: string | null = null;
  if (d.targetDate && d.status === 'in_progress' && saved < target) {
    const months = Math.max(1, monthsBetween(new Date().toISOString().slice(0, 10), d.targetDate));
    neededPerMonth = toMinorString((target - saved) / BigInt(months));
  }
  return {
    id: d._id,
    name: d.name,
    icon: d.icon,
    targetAmount: d.targetAmountMinor,
    targetDate: d.targetDate,
    accountId: d.accountId,
    categoryId: d.categoryId,
    savedAmount: d.savedAmountMinor,
    neededPerMonth,
    status: d.status,
    notes: d.notes,
    schedule: d.schedule
      ? { amount: d.schedule.amountMinor, recurrence: d.schedule.recurrence, startDate: d.schedule.startDate }
      : null,
    completedAt: d.completedAt?.toISOString() ?? null,
    version: d.version,
  };
};

const toAllocation = (d: GoalAllocationDoc): z.input<typeof Allocation> => ({
  id: d._id,
  goalId: d.goalId,
  date: d.date,
  amount: d.amountMinor,
  fromAccountId: d.fromAccountId,
  transactionId: d.transactionId,
  kind: d.kind ?? 'allocate',
  version: d.version,
});

type SpendBody = z.output<NonNullable<(typeof goalRouteDefs)['spend']['body']>>;

export class GoalsService {
  constructor(
    private readonly database: Database,
    private readonly goals: GoalsRepository,
    private readonly allocations: GoalAllocationsRepository,
    private readonly ledger: LedgerService,
    private readonly audit: AuditRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async list(ctx: WorkspaceContext, status: string): Promise<{ goals: z.input<typeof Goal>[] }> {
    const filter: Record<string, unknown> = {};
    if (status !== 'all') filter.status = status === 'completed' ? 'completed' : 'in_progress';
    const rows = await this.goals.find(ctx, filter, { sort: { createdAt: 1 } });
    return { goals: rows.map(toGoal) };
  }

  async get(ctx: WorkspaceContext, id: string) {
    const doc = await this.goals.findOne(ctx, { _id: id });
    if (!doc) throw Errors.notFound();
    const allocs = await this.allocations.find(ctx, { goalId: id }, { sort: { date: -1, _id: -1 } });
    return { goal: toGoal(doc), allocations: allocs.map(toAllocation) };
  }

  async getAllocation(ctx: WorkspaceContext, id: string) {
    const a = await this.allocations.findOne(ctx, { _id: id });
    if (!a) throw Errors.notFound();
    return toAllocation(a);
  }

  async create(ctx: WorkspaceContext, body: CreateBody, operationId: string): Promise<z.input<typeof Goal>> {
    if (body.id) {
      const existing = await this.goals.findOne(ctx, { _id: body.id });
      if (existing) return toGoal(existing);
    }
    const dup = await this.goals.findOne(ctx, { operationId });
    if (dup) return toGoal(dup);
    const now = this.now();
    const doc = await this.database.transaction(async (session) => {
      const created = await this.goals.insertOne(
        ctx,
        {
          _id: body.id ?? newId(),
          name: body.name,
          icon: body.icon ?? null,
          targetAmountMinor: body.targetAmount,
          targetDate: body.targetDate ?? null,
          accountId: body.accountId,
          categoryId: body.categoryId ?? null,
          savedAmountMinor: '0',
          status: 'in_progress',
          notes: body.notes ?? null,
          schedule: null,
          completedAt: null,
          operationId,
          createdAt: now,
          updatedAt: now,
          version: 1,
        },
        { session },
      );
      await this.ledger.feed(ctx, [{ collection: 'goals', docId: created._id, op: 'upsert' }], session);
      await this.audit.record(
        ctx,
        { action: 'goal.created', target: { collection: 'goals', id: created._id } },
        { session },
      );
      return created;
    });
    return toGoal(doc);
  }

  async update(ctx: WorkspaceContext, id: string, body: UpdateBody): Promise<z.input<typeof Goal>> {
    const doc = await this.database.transaction(async (session) => {
      const before = await this.goals.findOne(ctx, { _id: id }, { session });
      if (!before) throw Errors.notFound();
      const set: Partial<GoalDoc> = { updatedAt: this.now() };
      if (body.name !== undefined) set.name = body.name;
      if (body.icon !== undefined) set.icon = body.icon;
      if (body.targetAmount !== undefined) set.targetAmountMinor = body.targetAmount;
      if (body.targetDate !== undefined) set.targetDate = body.targetDate;
      if (body.accountId !== undefined) set.accountId = body.accountId;
      if (body.categoryId !== undefined) set.categoryId = body.categoryId;
      if (body.notes !== undefined) set.notes = body.notes;
      if (body.status !== undefined) {
        set.status = body.status;
        set.completedAt = body.status === 'completed' ? this.now() : null;
      }
      const after = await this.goals.findOneAndUpdate(
        ctx,
        { _id: id, version: body.baseVersion },
        { $set: set, $inc: { version: 1 } },
        { session },
      );
      if (!after) throw GoalErrors.stale(toGoal(before));
      await this.ledger.feed(ctx, [{ collection: 'goals', docId: id, op: 'upsert' }], session);
      return after;
    });
    return toGoal(doc);
  }

  async setSchedule(
    ctx: WorkspaceContext,
    id: string,
    body: z.output<NonNullable<(typeof goalRouteDefs)['setSchedule']['body']>>,
  ): Promise<z.input<typeof Goal>> {
    const doc = await this.database.transaction(async (session) => {
      const before = await this.goals.findOne(ctx, { _id: id }, { session });
      if (!before) throw Errors.notFound();
      const after = await this.goals.findOneAndUpdate(
        ctx,
        { _id: id, version: body.baseVersion },
        {
          $set: {
            schedule: { amountMinor: body.amount, recurrence: body.recurrence, startDate: body.startDate },
            updatedAt: this.now(),
          },
          $inc: { version: 1 },
        },
        { session },
      );
      if (!after) throw GoalErrors.stale(toGoal(before));
      await this.ledger.feed(ctx, [{ collection: 'goals', docId: id, op: 'upsert' }], session);
      return after;
    });
    return toGoal(doc);
  }

  async allocate(
    ctx: WorkspaceContext,
    goalId: string,
    body: AllocateBody,
    operationId: string,
  ): Promise<{ allocation: z.input<typeof Allocation>; goal: z.input<typeof Goal> }> {
    const result = await this.database.transaction(async (session) => {
      const goal = await this.goals.findOne(ctx, { _id: goalId, status: 'in_progress' }, { session });
      if (!goal) throw Errors.notFound();
      if (body.id) {
        const same = await this.allocations.findOne(ctx, { _id: body.id }, { session });
        if (same) return { goal, alloc: same };
      }
      let txId: string | null = null;
      const from = body.fromAccountId ?? goal.accountId;
      if (from !== goal.accountId) {
        const tx = await this.ledger.postIn(
          ctx,
          {
            type: 'transfer',
            fromAccountId: from,
            toAccountId: goal.accountId,
            amount: body.amount,
            date: body.date,
          },
          { operationId: `${operationId}:xfer` },
          session,
        );
        txId = tx._id;
      }
      const now = this.now();
      const alloc = await this.allocations.insertOne(
        ctx,
        {
          _id: body.id ?? newId(),
          goalId,
          date: body.date,
          amountMinor: body.amount,
          fromAccountId: from !== goal.accountId ? from : null,
          transactionId: txId,
          kind: 'allocate',
          createdAt: now,
          updatedAt: now,
          version: 1,
        },
        { session },
      );
      const saved = parseMinor(goal.savedAmountMinor) + parseMinor(body.amount);
      const after = await this.goals.findOneAndUpdate(
        ctx,
        { _id: goalId },
        {
          $set: { savedAmountMinor: toMinorString(saved), updatedAt: now },
          $inc: { version: 1 },
        },
        { session },
      );
      if (!after) throw Errors.notFound();
      await this.ledger.feed(
        ctx,
        [
          { collection: 'goals', docId: goalId, op: 'upsert' },
          { collection: 'goal_allocations', docId: alloc._id, op: 'upsert' },
        ],
        session,
      );
      await this.audit.record(
        ctx,
        { action: 'goal.allocated', target: { collection: 'goals', id: goalId } },
        { session },
      );
      return { goal: after, alloc };
    });
    return { allocation: toAllocation(result.alloc), goal: toGoal(result.goal) };
  }

  /** E19: expense linked by goalId; earmark down; not category overspend (TECH-SPEC 6.6). */
  async spend(
    ctx: WorkspaceContext,
    goalId: string,
    body: SpendBody,
    operationId: string,
  ): Promise<{
    goal: z.input<typeof Goal>;
    allocation: z.input<typeof Allocation>;
    transactionId: string;
  }> {
    const amount = parseMinor(body.amount);
    if (amount <= 0n) throw Errors.validation('amount', 'Enter an amount above ₦0.00');
    const result = await this.database.transaction(async (session) => {
      const goal = await this.goals.findOne(ctx, { _id: goalId, status: 'in_progress' }, { session });
      if (!goal) throw Errors.notFound();
      if (body.id) {
        const same = await this.allocations.findOne(ctx, { _id: body.id }, { session });
        if (same) {
          return {
            goal,
            alloc: same,
            transactionId: same.transactionId ?? '',
          };
        }
      }
      const saved = parseMinor(goal.savedAmountMinor);
      if (amount > saved) {
        throw Errors.validation('amount', 'There is not that much saved in this goal.');
      }
      const accountId = body.accountId ?? goal.accountId;
      const tx = await this.ledger.postIn(
        ctx,
        {
          type: 'expense',
          accountId,
          categoryId: body.categoryId,
          amount: body.amount,
          date: body.date,
          payeeId: body.payeeId ?? null,
          notes: body.notes ?? null,
          goalId,
        },
        { operationId },
        session,
      );
      const now = this.now();
      const alloc = await this.allocations.insertOne(
        ctx,
        {
          _id: body.id ?? newId(),
          goalId,
          date: body.date,
          amountMinor: body.amount,
          fromAccountId: accountId,
          transactionId: tx._id,
          kind: 'spend',
          createdAt: now,
          updatedAt: now,
          version: 1,
        },
        { session },
      );
      const after = await this.goals.findOneAndUpdate(
        ctx,
        { _id: goalId },
        {
          $set: { savedAmountMinor: toMinorString(saved - amount), updatedAt: now },
          $inc: { version: 1 },
        },
        { session },
      );
      if (!after) throw Errors.notFound();
      await this.ledger.feed(
        ctx,
        [
          { collection: 'goals', docId: goalId, op: 'upsert' },
          { collection: 'goal_allocations', docId: alloc._id, op: 'upsert' },
        ],
        session,
      );
      await this.audit.record(ctx, { action: 'goal.spent', target: { collection: 'goals', id: goalId } }, { session });
      return { goal: after, alloc, transactionId: tx._id };
    });
    return {
      goal: toGoal(result.goal),
      allocation: toAllocation(result.alloc),
      transactionId: result.transactionId,
    };
  }

  /** PU-30-1: delete goal metadata only — money stays in the account. */
  async remove(ctx: WorkspaceContext, id: string, baseVersion: number): Promise<void> {
    await this.database.transaction(async (session) => {
      const before = await this.goals.findOne(ctx, { _id: id }, { session });
      if (!before) throw Errors.notFound();
      if (before.version !== baseVersion) throw GoalErrors.stale(toGoal(before));
      const allocs = await this.allocations.find(ctx, { goalId: id }, { session });
      for (const a of allocs) {
        await this.allocations.deleteOne(ctx, { _id: a._id }, { session });
        await this.ledger.feed(ctx, [{ collection: 'goal_allocations', docId: a._id, op: 'tombstone' }], session);
      }
      await this.goals.deleteOne(ctx, { _id: id }, { session });
      await this.ledger.feed(ctx, [{ collection: 'goals', docId: id, op: 'tombstone' }], session);
      await this.audit.record(ctx, { action: 'goal.deleted', target: { collection: 'goals', id } }, { session });
    });
  }
}
