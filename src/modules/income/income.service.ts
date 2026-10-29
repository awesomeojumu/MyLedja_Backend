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

type SteadinessDot = z.input<typeof IncomeStream>['steadinessDots'][number];

const prevMonth = (month: string): string => {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
};

const toStream = (
  sched: z.input<typeof Schedule>,
  doc: IncomeStreamDoc,
  expected: string,
  received: string,
  steadinessDots: SteadinessDot[] = [],
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
  steadinessDots,
  expectedThisMonth: expected,
  receivedThisMonth: received,
});

function dotFromOccurrence(o: {
  status: string;
  date: string;
  amount: string;
  paidAt: string | null;
}): SteadinessDot | null {
  if (o.status === 'skipped') return null;
  if (o.status !== 'received') return 'missed';
  const paidDay = o.paidAt?.slice(0, 10) ?? null;
  if (paidDay && paidDay > o.date) return 'late';
  return 'on_time';
}

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
    const linkedIds = new Set<string>();
    for (const doc of docs) {
      for (const id of doc.linkedTransactionIds) linkedIds.add(id);
      const sched = await this.schedules.get(ctx, doc.scheduleId);
      const { occurrences } = await this.schedules.listOccurrences(ctx, month, doc.scheduleId);
      let expected = 0n;
      let received = 0n;
      for (const o of occurrences) {
        if (o.status === 'skipped') continue;
        expected += parseMinor(o.amount);
        if (o.status === 'received') received += parseMinor(o.amount);
        if (o.matchedTransactionId) linkedIds.add(o.matchedTransactionId);
      }
      // Last six months of dots (oldest → newest).
      const dots: SteadinessDot[] = [];
      let cursor = month;
      for (let i = 0; i < 6; i += 1) {
        const { occurrences: hist } = await this.schedules.listOccurrences(ctx, cursor, doc.scheduleId);
        const primary = hist.find((o) => o.status !== 'skipped') ?? hist[0];
        if (primary) {
          const d = dotFromOccurrence(primary);
          if (d) dots.unshift(d);
        } else if (cursor < month) {
          dots.unshift('missed');
        }
        cursor = prevMonth(cursor);
      }
      expectedTotal += expected;
      receivedTotal += received;
      streamViews.push(toStream(sched, doc, toMinorString(expected), toMinorString(received), dots.slice(-6)));
    }
    const onTimeStreams = streamViews.filter((s) => {
      if (s.streamKind !== 'regular' && s.streamKind !== 'varies') return false;
      return parseMinor(s.receivedThisMonth) >= parseMinor(s.expectedThisMonth) && parseMinor(s.expectedThisMonth) > 0n;
    });
    const regularCount = streamViews.filter((s) => s.streamKind === 'regular' || s.streamKind === 'varies').length;
    const summary: z.input<typeof IncomeMonthSummary> = {
      month,
      expected: toMinorString(expectedTotal),
      received: toMinorString(receivedTotal),
      stillToCome: toMinorString(expectedTotal > receivedTotal ? expectedTotal - receivedTotal : 0n),
      steadinessPercent: regularCount > 0 ? Math.round((onTimeStreams.length / regularCount) * 100) : null,
    };
    const start = `${month}-01`;
    const [y, mo] = month.split('-').map(Number) as [number, number];
    const end =
      mo === 12 ? `${y + 1}-01-01` : `${y}-${String(mo + 1).padStart(2, '0')}-01`;
    const txs = await this.ledger.transactions.find(ctx, {
      type: { $in: ['income', 'salary_gross'] },
      status: 'posted',
      date: { $gte: start, $lt: end },
      oneOff: { $ne: true },
    } as never);
    const unmatched: z.input<typeof UnmatchedIncome>[] = [];
    for (const doc of txs) {
      if (linkedIds.has(doc._id)) continue;
      if (doc.links.scheduleId && docs.some((s) => s.scheduleId === doc.links.scheduleId)) continue;
      const { transaction } = await this.transactions.get(ctx, doc._id);
      unmatched.push({ transaction, suggestedStreamIds: docs.map((d) => d._id).slice(0, 5) });
    }
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
    const before = await this.transactions.get(ctx, transactionId);
    await this.ledger.patch(ctx, transactionId, { oneOff: true }, before.transaction.version);
    const streams = await this.streams.find(ctx, { linkedTransactionIds: transactionId } as never);
    for (const s of streams) {
      await this.streams.findOneAndUpdate(
        ctx,
        { _id: s._id },
        {
          $pull: { linkedTransactionIds: transactionId },
          $inc: { version: 1 },
          $set: { updatedAt: this.now() },
        } as never,
      );
    }
    return (await this.transactions.get(ctx, transactionId)).transaction;
  }

  async getStreamDoc(ctx: WorkspaceContext, id: string) {
    const doc = await this.streams.findOne(ctx, { _id: id });
    if (!doc) throw Errors.notFound();
    const sched = await this.schedules.get(ctx, doc.scheduleId);
    return toStream(sched, doc, sched.amount, '0');
  }
}
