import type { ClientSession } from 'mongodb';
import type { z } from 'zod';
import { AppError, Errors } from '../../common/errors/errors.js';
import { newId } from '../../common/ids/ids.js';
import { parseMinor, toMinorString } from '../../common/money/money.js';
import type { WorkspaceContext } from '../../common/workspace/workspace-context.js';
import type { Database } from '../../db/client.js';
import type { AuditRepository } from '../audit/audit.repository.js';
import type { LedgerService } from '../ledger/ledger.service.js';
import type { TransactionsService } from '../transactions/transactions.service.js';
import { scheduleRoutes as scheduleRouteDefs } from './schedules.contract.js';
import type { Occurrence, PlanMonthSummary, RecurringCandidate, Schedule } from './schedules.contract.js';
import { firstNextDate, occurrencesInMonth } from './recurrence.js';
import {
  type OccurrenceDoc,
  OccurrencesRepository,
  type ScheduleDoc,
  SchedulesRepository,
} from './schedules.repository.js';

type CreateBody = z.output<NonNullable<(typeof scheduleRouteDefs)['create']['body']>>;
type UpdateBody = z.output<NonNullable<(typeof scheduleRouteDefs)['update']['body']>>;

const toSchedule = (d: ScheduleDoc): z.input<typeof Schedule> => ({
  id: d._id,
  kind: d.kind,
  name: d.name,
  payeeId: d.payeeId,
  accountId: d.accountId,
  categoryId: d.categoryId,
  amount: d.amountMinor,
  amountApproximate: d.amountApproximate,
  recurrence: d.recurrence,
  startDate: d.startDate,
  end: d.end,
  autoPost: d.autoPost,
  reminder: d.reminder,
  nextDate: d.nextDate,
  status: d.status,
  cancelledAt: d.cancelledAt?.toISOString() ?? null,
  version: d.version,
});

const toOccurrence = (d: OccurrenceDoc): z.input<typeof Occurrence> => ({
  id: d._id,
  scheduleId: d.scheduleId,
  date: d.date,
  amount: d.amountMinor,
  status: d.status,
  matchedTransactionId: d.matchedTransactionId,
  paidAt: d.paidAt?.toISOString() ?? null,
  version: d.version,
});

export class SchedulesService {
  constructor(
    private readonly database: Database,
    private readonly schedules: SchedulesRepository,
    private readonly occurrences: OccurrencesRepository,
    private readonly ledger: LedgerService,
    private readonly transactions: TransactionsService,
    private readonly audit: AuditRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async list(
    ctx: WorkspaceContext,
    q: { kind?: string; status: string; cursor?: string; limit: number },
  ): Promise<{ items: z.input<typeof Schedule>[]; nextCursor: string | null }> {
    const filter: Record<string, unknown> = {};
    if (q.kind) filter.kind = q.kind;
    if (q.status !== 'all') filter.status = q.status;
    const rows = await this.schedules.page(ctx, filter, q.cursor, q.limit);
    const items = rows.slice(0, q.limit).map(toSchedule);
    const nextCursor = rows.length > q.limit ? rows[q.limit]!._id : null;
    return { items, nextCursor };
  }

  async get(ctx: WorkspaceContext, id: string): Promise<z.input<typeof Schedule>> {
    const doc = await this.schedules.findOne(ctx, { _id: id });
    if (!doc) throw Errors.notFound();
    return toSchedule(doc);
  }

  async getOccurrence(ctx: WorkspaceContext, id: string): Promise<z.input<typeof Occurrence>> {
    const doc = await this.occurrences.findOne(ctx, { _id: id });
    if (!doc) throw Errors.notFound();
    return toOccurrence(doc);
  }

  async create(ctx: WorkspaceContext, body: CreateBody, operationId: string): Promise<z.input<typeof Schedule>> {
    if (body.id) {
      const existing = await this.schedules.findOne(ctx, { _id: body.id });
      if (existing) return toSchedule(existing);
    }
    const dup = await this.schedules.findOne(ctx, { operationId });
    if (dup) return toSchedule(dup);
    const now = this.now();
    const today = now.toISOString().slice(0, 10);
    const amountMinor = parseMinor(body.amount);
    const end = body.end ?? { kind: 'never' as const };
    const nextDate = firstNextDate(body.startDate, body.recurrence, end, today);
    const doc = await this.database.transaction(async (session) => {
      const created = await this.schedules.insertOne(
        ctx,
        {
          _id: body.id ?? newId(),
          kind: body.kind,
          name: body.name,
          payeeId: body.payeeId ?? null,
          accountId: body.accountId ?? null,
          categoryId: body.categoryId ?? null,
          amountMinor: toMinorString(amountMinor),
          amountApproximate: body.amountApproximate ?? false,
          recurrence: body.recurrence,
          startDate: body.startDate,
          end,
          autoPost: body.autoPost ?? false,
          reminder: body.reminder ?? null,
          nextDate,
          status: 'active',
          cancelledAt: null,
          operationId,
          createdAt: now,
          updatedAt: now,
          version: 1,
        },
        { session },
      );
      await this.feed(ctx, [{ collection: 'schedules', docId: created._id, op: 'upsert' }], session);
      await this.audit.record(
        ctx,
        { action: 'schedule.create', target: { collection: 'schedules', id: created._id } },
        { session },
      );
      return created;
    });
    return toSchedule(doc);
  }

  async update(ctx: WorkspaceContext, id: string, body: UpdateBody): Promise<z.input<typeof Schedule>> {
    const before = await this.schedules.findOne(ctx, { _id: id });
    if (!before) throw Errors.notFound();
    if (before.version !== body.baseVersion) {
      throw new AppError(409, 'already_changed', 'This was already changed on another device.', {
        current: await this.get(ctx, id),
      });
    }
    const now = this.now();
    const patch: Partial<ScheduleDoc> = { updatedAt: now };
    if (body.name !== undefined) patch.name = body.name;
    if (body.payeeId !== undefined) patch.payeeId = body.payeeId;
    if (body.accountId !== undefined) patch.accountId = body.accountId;
    if (body.categoryId !== undefined) patch.categoryId = body.categoryId;
    if (body.amount !== undefined) patch.amountMinor = toMinorString(parseMinor(body.amount));
    if (body.amountApproximate !== undefined) patch.amountApproximate = body.amountApproximate;
    if (body.recurrence !== undefined) patch.recurrence = body.recurrence;
    if (body.startDate !== undefined) patch.startDate = body.startDate;
    if (body.end !== undefined) patch.end = body.end;
    if (body.autoPost !== undefined) patch.autoPost = body.autoPost;
    if (body.reminder !== undefined) patch.reminder = body.reminder;
    if (body.status !== undefined) patch.status = body.status;
    const recurrence = patch.recurrence ?? before.recurrence;
    const startDate = patch.startDate ?? before.startDate;
    const end = patch.end ?? before.end;
    patch.nextDate = firstNextDate(startDate, recurrence, end, now.toISOString().slice(0, 10));
    const after = await this.database.transaction(async (session) => {
      const row = await this.schedules.findOneAndUpdate(
        ctx,
        { _id: id, version: body.baseVersion },
        { $set: patch, $inc: { version: 1 } },
        { session },
      );
      if (!row) {
        throw new AppError(409, 'already_changed', 'This was already changed on another device.', {
          current: await this.get(ctx, id),
        });
      }
      await this.feed(ctx, [{ collection: 'schedules', docId: id, op: 'upsert' }], session);
      return row;
    });
    return toSchedule(after);
  }

  async cancel(ctx: WorkspaceContext, id: string, baseVersion: number): Promise<z.input<typeof Schedule>> {
    const before = await this.schedules.findOne(ctx, { _id: id });
    if (!before) throw Errors.notFound();
    if (before.version !== baseVersion) {
      throw new AppError(409, 'already_changed', 'This was already changed on another device.', {
        current: await this.get(ctx, id),
      });
    }
    const now = this.now();
    const after = await this.database.transaction(async (session) => {
      const row = await this.schedules.findOneAndUpdate(
        ctx,
        { _id: id, version: baseVersion },
        { $set: { status: 'cancelled', cancelledAt: now, nextDate: null, updatedAt: now }, $inc: { version: 1 } },
        { session },
      );
      if (!row) {
        throw new AppError(409, 'already_changed', 'This was already changed on another device.', {
          current: await this.get(ctx, id),
        });
      }
      await this.feed(ctx, [{ collection: 'schedules', docId: id, op: 'upsert' }], session);
      return row;
    });
    return toSchedule(after);
  }

  async ensureMonth(ctx: WorkspaceContext, month: string, session?: ClientSession): Promise<void> {
    const active = await this.schedules.find(ctx, { status: { $in: ['active', 'paused'] } }, { session });
    const today = this.now().toISOString().slice(0, 10);
    for (const s of active) {
      for (const date of occurrencesInMonth(s.startDate, s.recurrence, s.end, month)) {
        const existing = await this.occurrences.byScheduleDate(ctx, s._id, date, { session });
        if (existing) continue;
        const now = this.now();
        let status: OccurrenceDoc['status'] = 'scheduled';
        if (date < today) status = 'overdue';
        else if (date === today) status = s.kind === 'income' ? 'due' : 'due';
        await this.occurrences.insertOne(
          ctx,
          {
            _id: newId(),
            scheduleId: s._id,
            date,
            amountMinor: s.amountMinor,
            status,
            matchedTransactionId: null,
            paidAt: null,
            createdAt: now,
            updatedAt: now,
            version: 1,
          },
          { session },
        );
      }
    }
  }

  async listOccurrences(
    ctx: WorkspaceContext,
    month: string,
    scheduleId?: string,
  ): Promise<{ occurrences: z.input<typeof Occurrence>[]; schedules: z.input<typeof Schedule>[] }> {
    await this.database.transaction((session) => this.ensureMonth(ctx, month, session));
    const occ = await this.occurrences.forMonth(ctx, month, scheduleId);
    const scheduleIds = [...new Set(occ.map((o) => o.scheduleId))];
    const schedRows =
      scheduleIds.length > 0
        ? await this.schedules.find(ctx, { _id: { $in: scheduleIds } })
        : scheduleId
          ? await this.schedules.find(ctx, { _id: scheduleId })
          : [];
    return { occurrences: occ.map(toOccurrence), schedules: schedRows.map(toSchedule) };
  }

  async planSummary(ctx: WorkspaceContext, month: string): Promise<z.input<typeof PlanMonthSummary>> {
    const { occurrences } = await this.listOccurrences(ctx, month);
    let comingIn = 0n;
    let goingOut = 0n;
    let missedCount = 0;
    for (const o of occurrences) {
      if (o.status === 'paid' || o.status === 'received' || o.status === 'skipped') continue;
      const sched = await this.schedules.findOne(ctx, { _id: o.scheduleId });
      if (!sched) continue;
      const amt = parseMinor(o.amount);
      if (sched.kind === 'income') comingIn += amt;
      else goingOut += amt;
      if (o.status === 'missed' || o.status === 'overdue') missedCount += 1;
    }
    return {
      month,
      comingIn: toMinorString(comingIn),
      goingOut: toMinorString(goingOut),
      leftAfterBills: toMinorString(comingIn - goingOut),
      missedCount,
      matchBannerCount: 0,
    };
  }

  async markPaid(
    ctx: WorkspaceContext,
    occurrenceId: string,
    body: z.output<NonNullable<(typeof scheduleRouteDefs)['markPaid']['body']>>,
    operationId: string,
  ) {
    return this.mark(ctx, occurrenceId, body, operationId, false);
  }

  async markReceived(
    ctx: WorkspaceContext,
    occurrenceId: string,
    body: z.output<NonNullable<(typeof scheduleRouteDefs)['markReceived']['body']>>,
    operationId: string,
  ) {
    return this.mark(ctx, occurrenceId, body, operationId, true);
  }

  private async mark(
    ctx: WorkspaceContext,
    occurrenceId: string,
    body: { matchTransactionId?: string; create?: { date: string; amount?: string; notes?: string | null } },
    operationId: string,
    income: boolean,
  ) {
    const occ = await this.occurrences.findOne(ctx, { _id: occurrenceId });
    if (!occ) throw Errors.notFound();
    const done = income ? 'received' : 'paid';
    if (occ.status === done) {
      throw new AppError(
        409,
        'already_paid',
        `Already ${done} on ${occ.paidAt?.toISOString().slice(0, 10) ?? occ.date}.`,
        {
          paidAt: occ.paidAt?.toISOString() ?? null,
        },
      );
    }
    const sched = await this.schedules.findOne(ctx, { _id: occ.scheduleId });
    if (!sched) throw Errors.notFound();
    let tx = null;
    if (body.matchTransactionId) {
      tx = (await this.transactions.get(ctx, body.matchTransactionId)).transaction;
    } else if (body.create) {
      const amount = body.create.amount ?? occ.amountMinor;
      const date = body.create.date;
      if (income || sched.kind === 'income') {
        if (!sched.accountId || !sched.categoryId)
          throw Errors.validation('categoryId', 'Choose an account and category.');
        tx = await this.transactions.create(
          ctx,
          {
            type: 'income',
            accountId: sched.accountId,
            categoryId: sched.categoryId,
            amount,
            date,
            notes: body.create.notes,
          },
          `${operationId}:tx`,
        );
      } else {
        if (!sched.accountId || !sched.categoryId)
          throw Errors.validation('categoryId', 'Choose an account and category.');
        tx = await this.transactions.create(
          ctx,
          {
            type: 'expense',
            accountId: sched.accountId,
            categoryId: sched.categoryId,
            amount,
            date,
            notes: body.create.notes,
          },
          `${operationId}:tx`,
        );
      }
    } else {
      throw Errors.validation('matchTransactionId', 'Pick a transaction or create one.');
    }
    const now = this.now();
    const updated = await this.database.transaction(async (session) => {
      const row = await this.occurrences.findOneAndUpdate(
        ctx,
        { _id: occurrenceId, status: { $nin: [done] } },
        {
          $set: {
            status: done,
            matchedTransactionId: tx!.id,
            paidAt: now,
            updatedAt: now,
          },
          $inc: { version: 1 },
        },
        { session },
      );
      if (!row) throw new AppError(409, 'already_paid', `Already ${done}.`);
      await this.feed(ctx, [{ collection: 'occurrences', docId: occurrenceId, op: 'upsert' }], session);
      return row;
    });
    return { occurrence: toOccurrence(updated), transaction: tx };
  }

  async findRecurring(
    ctx: WorkspaceContext,
    _body: { from?: string; to?: string },
  ): Promise<{ candidates: z.input<typeof RecurringCandidate>[] }> {
    const txs = await this.ledger.transactions.find(ctx, {}, { sort: { date: -1 }, limit: 500 });
    const byPayee = new Map<string, typeof txs>();
    for (const t of txs) {
      if (!t.payeeId || t.type !== 'expense') continue;
      const list = byPayee.get(t.payeeId) ?? [];
      list.push(t);
      byPayee.set(t.payeeId, list);
    }
    const candidates: z.input<typeof RecurringCandidate>[] = [];
    for (const [payeeId, list] of byPayee) {
      if (list.length < 3) continue;
      const slice = list.slice(0, 6);
      const total = slice.reduce((s, t) => {
        const spent = t.lines.filter((l) => l.amountMinor < 0n).reduce((a, l) => a - l.amountMinor, 0n);
        return s + spent;
      }, 0n);
      const avg = total / BigInt(slice.length || 1);
      candidates.push({
        payeeId,
        payeeName: payeeId,
        recurrence: { every: 1, unit: 'month', dayOfMonth: parseInt(list[0]!.date.slice(8, 10), 10), weekday: null },
        averageAmount: toMinorString(avg),
        lastDate: list[0]!.date,
        confidence: list.length >= 5 ? 'strong' : 'likely',
        sampleTransactionIds: list.slice(0, 5).map((t) => t._id),
      });
    }
    return { candidates };
  }

  private feed(
    ctx: WorkspaceContext,
    items: { collection: string; docId: string; op: 'upsert' | 'tombstone' }[],
    session: ClientSession,
  ) {
    return this.ledger.feed(ctx, items, session);
  }
}
