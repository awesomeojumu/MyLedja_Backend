import type { z } from 'zod';
import { AppError, Errors } from '../../common/errors/errors.js';
import { newId } from '../../common/ids/ids.js';
import { parseMinor, toMinorString } from '../../common/money/money.js';
import type { WorkspaceContext } from '../../common/workspace/workspace-context.js';
import type { Database } from '../../db/client.js';
import type { AuditRepository } from '../audit/audit.repository.js';
import type { LedgerService } from '../ledger/ledger.service.js';
import type { Schedule } from '../schedules/schedules.contract.js';
import type { SchedulesService } from '../schedules/schedules.service.js';
import type { TransactionsService } from '../transactions/transactions.service.js';
import { incomeRoutes as incomeRouteDefs } from './income.contract.js';
import type { IncomeMonthSummary, IncomeStream, UnmatchedIncome } from './income.contract.js';
import { IncomeStreamsRepository, type IncomeStreamDoc } from './income.repository.js';

type CreateBody = z.output<NonNullable<(typeof incomeRouteDefs)['createStream']['body']>>;
type UpdateBody = z.output<NonNullable<(typeof incomeRouteDefs)['updateStream']['body']>>;

const IncomeErrors = {
  stale: () => new AppError(409, 'already_changed', 'This was already changed on another device.'),
};

const toStream = (
  sched: z.input<typeof Schedule>,
  doc: IncomeStreamDoc,
  expected: string,
  received: string,
): z.input<typeof IncomeStream> => ({
  ...sched,
  id: doc._id,
  streamKind: doc.streamKind,
  employerOrSource: doc.employerOrSource,
  taxClass: doc.taxClass as z.input<typeof IncomeStream>['taxClass'],
  countInBudget: doc.countInBudget,
  recordAs: doc.recordAs,
  grossAmount: doc.grossAmountMinor,
  deductions: doc.deductions,
  routing: doc.routing,
  amountRange: doc.amountRange ? { min: doc.amountRange.minMinor, max: doc.amountRange.maxMinor } : null,
  steadinessDots: [],
  expectedThisMonth: expected,
  receivedThisMonth: received,
});

export class IncomeService {
  constructor(
    private readonly database: Database,
    private readonly streams: IncomeStreamsRepository,
    private readonly schedules: SchedulesService,
    private readonly transactions: TransactionsService,
    private readonly ledger: LedgerService,
    private readonly audit: AuditRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async getMonth(ctx: WorkspaceContext, month: string) {
    const docs = await this.streams.find(ctx, {});
    const streamViews: z.input<typeof IncomeStream>[] = [];
    let expectedTotal = 0n;
    let receivedTotal = 0n;
    for (const doc of docs) {
      const sched = await this.schedules.get(ctx, doc.scheduleId);
      const { occurrences } = await this.schedules.listOccurrences(ctx, month, doc.scheduleId);
      let expected = 0n;
      let received = 0n;
      for (const o of occurrences) {
        if (o.status === 'skipped') continue;
        expected += parseMinor(o.amount);
        if (o.status === 'received') received += parseMinor(o.amount);
      }
      expectedTotal += expected;
      receivedTotal += received;
      streamViews.push(toStream(sched, doc, toMinorString(expected), toMinorString(received)));
    }
    const summary: z.input<typeof IncomeMonthSummary> = {
      month,
      expected: toMinorString(expectedTotal),
      received: toMinorString(receivedTotal),
      stillToCome: toMinorString(expectedTotal > receivedTotal ? expectedTotal - receivedTotal : 0n),
      steadinessPercent: expectedTotal > 0n ? Number((receivedTotal * 100n) / expectedTotal) : null,
    };
    const unmatched: z.input<typeof UnmatchedIncome>[] = [];
    return { summary, streams: streamViews, unmatched };
  }

  async createStream(
    ctx: WorkspaceContext,
    body: CreateBody,
    operationId: string,
  ): Promise<z.input<typeof IncomeStream>> {
    if (body.id) {
      const existing = await this.streams.findOne(ctx, { _id: body.id });
      if (existing) {
        const sched = await this.schedules.get(ctx, existing.scheduleId);
        return toStream(sched, existing, body.amount, '0');
      }
    }
    const schedule = await this.schedules.create(
      ctx,
      {
        kind: 'income',
        name: body.name,
        accountId: body.accountId,
        categoryId: body.categoryId,
        amount: body.amount,
        amountApproximate: body.amountApproximate,
        recurrence: body.recurrence,
        startDate: body.startDate,
        reminder: body.reminder ?? null,
      } as never,
      operationId,
    );
    const now = this.now();
    const stream = await this.streams.insertOne(ctx, {
      _id: body.id ?? newId(),
      scheduleId: schedule.id,
      streamKind: body.streamKind,
      employerOrSource: body.employerOrSource ?? null,
      taxClass: body.taxClass,
      countInBudget: body.countInBudget ?? true,
      recordAs: body.recordAs ?? 'take_home',
      grossAmountMinor: body.grossAmount ?? null,
      deductions: body.deductions ?? [],
      routing: body.routing ?? [],
      amountRange: body.amountRange ? { minMinor: body.amountRange.min, maxMinor: body.amountRange.max } : null,
      linkedTransactionIds: [],
      createdAt: now,
      updatedAt: now,
      version: 1,
    });
    await this.database.transaction(async (session) => {
      await this.ledger.feed(ctx, [{ collection: 'income_streams', docId: stream._id, op: 'upsert' }], session);
    });
    await this.audit.record(
      ctx,
      { action: 'income.stream.created', target: { collection: 'income_streams', id: stream._id } },
      {},
    );
    return toStream(schedule, stream, body.amount, '0');
  }

  async updateStream(ctx: WorkspaceContext, streamId: string, body: UpdateBody): Promise<z.input<typeof IncomeStream>> {
    const before = await this.streams.findOne(ctx, { _id: streamId });
    if (!before) throw Errors.notFound();
    const schedBefore = await this.schedules.get(ctx, before.scheduleId);
    const set: Partial<IncomeStreamDoc> = { updatedAt: this.now() };
    if (body.employerOrSource !== undefined) set.employerOrSource = body.employerOrSource;
    if (body.streamKind !== undefined) set.streamKind = body.streamKind;
    if (body.taxClass !== undefined) set.taxClass = body.taxClass;
    if (body.countInBudget !== undefined) set.countInBudget = body.countInBudget;
    if (body.recordAs !== undefined) set.recordAs = body.recordAs;
    if (body.grossAmount !== undefined) set.grossAmountMinor = body.grossAmount;
    if (body.deductions !== undefined) set.deductions = body.deductions;
    if (body.routing !== undefined) set.routing = body.routing;
    const after = await this.streams.findOneAndUpdate(
      ctx,
      { _id: streamId, version: body.baseVersion },
      { $set: set, $inc: { version: 1 } },
    );
    if (!after) throw IncomeErrors.stale();
    if (body.name || body.amount || body.accountId || body.categoryId || body.status) {
      await this.schedules.update(ctx, before.scheduleId, {
        baseVersion: schedBefore.version,
        ...(body.name ? { name: body.name } : {}),
        ...(body.amount ? { amount: body.amount } : {}),
        ...(body.accountId ? { accountId: body.accountId } : {}),
        ...(body.categoryId ? { categoryId: body.categoryId } : {}),
        ...(body.status ? { status: body.status } : {}),
      } as never);
    }
    await this.database.transaction(async (session) => {
      await this.ledger.feed(ctx, [{ collection: 'income_streams', docId: streamId, op: 'upsert' }], session);
    });
    const sched = await this.schedules.get(ctx, before.scheduleId);
    return toStream(sched, after, sched.amount, '0');
  }

  async linkTransaction(
    ctx: WorkspaceContext,
    streamId: string,
    body: z.output<NonNullable<(typeof incomeRouteDefs)['linkTransaction']['body']>>,
  ): Promise<z.input<typeof IncomeStream>> {
    const doc = await this.streams.findOne(ctx, { _id: streamId });
    if (!doc) throw Errors.notFound();
    await this.transactions.get(ctx, body.transactionId);
    const after = await this.streams.findOneAndUpdate(
      ctx,
      { _id: streamId },
      { $addToSet: { linkedTransactionIds: body.transactionId }, $inc: { version: 1 } },
    );
    const sched = await this.schedules.get(ctx, doc.scheduleId);
    return toStream(sched, after!, body.amount ?? sched.amount, body.amount ?? sched.amount);
  }

  async markOneOff(ctx: WorkspaceContext, transactionId: string) {
    const { transaction } = await this.transactions.get(ctx, transactionId);
    return transaction;
  }

  async getStreamDoc(ctx: WorkspaceContext, id: string) {
    const doc = await this.streams.findOne(ctx, { _id: id });
    if (!doc) throw Errors.notFound();
    const sched = await this.schedules.get(ctx, doc.scheduleId);
    return toStream(sched, doc, sched.amount, '0');
  }
}
